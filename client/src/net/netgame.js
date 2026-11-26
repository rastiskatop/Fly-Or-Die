import { Vector2 } from '@flyordie/shared/sim/vector.js';
import { World } from '@flyordie/shared/sim/world.js';
import { Explosion } from '@flyordie/shared/sim/explosion.js';
import { ASTEROID_RADIUS } from '@flyordie/shared/sim/asteroid.js';
import { stepShipMotion, FIRE_COOLDOWN_S, BULLET_SPEEDS } from '@flyordie/shared/sim/ship.js';
import {
  TICK_RATE,
  DT,
  INPUT_REDUNDANCY,
  buttonsToControls,
} from '@flyordie/shared/net/protocol.js';
import * as binaryCodec from '@flyordie/shared/net/codec-binary.js';
import * as jsonCodec from '@flyordie/shared/net/codec-json.js';

const TICK_MS = 1000 / TICK_RATE;
const SMOOTH_TAU_S = 0.035; // correction smoothing time constant: ~95% gone after 100 ms
const TELEPORT_PX = 120; // corrections bigger than this (respawn, wrap) snap instead of smoothing
const BULLET_TTL = 1.2;
const MAX_SNAPSHOTS = 60; // 2 s of history at 30 Hz

/**
 * Client side of the authoritative-server model (Lab 5).
 *
 *  - own ship: PREDICTED with the shared stepShipMotion(), one step per input (DT = 1/30 s).
 *    On every snapshot: reset to the server's state, drop acked inputs, REPLAY the rest
 *    (reconciliation), and hide the remaining jump with an exponentially decaying visual offset.
 *  - own bullets: predicted at the moment of firing, keyed by the input seq that fired them;
 *    the server's bullet (same spawnSeq) confirms them, its disappearance removes them.
 *  - everything else: INTERPOLATED between the two snapshots around now − interpolationDelay.
 *  - events (explosions, sounds, popups) are replayed at render time, so they line up with the
 *    interpolated picture.
 */
export class NetGame {
  constructor({ conn, codec, bounds, selfPlayerId, flags = {} }) {
    this.conn = conn;
    this.codec = codec === 'json' ? jsonCodec : binaryCodec;
    this.codecName = codec;
    this.bounds = bounds;
    this.selfPlayerId = selfPlayerId;
    this.selfShipId = null;
    this.names = new Map(); // shipId -> pilot name

    this.prediction = flags.prediction ?? true;
    this.interpolation = flags.interpolation ?? true;
    this.interpDelayMs = flags.interpDelayMs ?? 100;

    this.seq = 0;
    this.pending = []; // unacknowledged inputs { seq, buttons }
    this.snapshots = []; // { tick, ack, entities, byId, recvAt }
    this.latest = null;
    this.tickBase = null; // client time (ms) at which server tick 0 "happened", min-tracking estimate

    this.me = null; // predicted ship (ship-shaped object usable by stepShipMotion + drawWorld)
    this.smooth = { x: 0, y: 0 };
    this.predictedBullets = new Map(); // spawnSeq -> bullet-ish
    this.pendingEvents = []; // { tick, event }

    // Explosions are purely visual: a local World holding only Explosion entities.
    this.effects = new World({ width: bounds.width, height: bounds.height, seed: 1 });

    // The same EventTarget-shaped "world" that audio.js and hud.js already understand.
    this.bus = new EventTarget();
    this.bus.width = bounds.width;
    this.bus.height = bounds.height;
    Object.defineProperty(this.bus, 'size', { get: () => this.latest?.entities.length ?? 0 });

    this.stats = {
      rttMs: 0,
      corrections: [], // last N correction magnitudes (px)
      lastCorrection: 0,
      snapshotsMissed: 0,
      bytesInPerS: 0,
      bytesOutPerS: 0,
      serverTick: 0,
    };
    this.history = { rtt: [], age: [], correction: [], pending: [] };
  }

  // ---------- roster → which ship is mine ----------
  setRoster(players) {
    this.names.clear();
    for (const p of players) {
      if (p.shipId) this.names.set(p.shipId, p.name);
      if (p.id === this.selfPlayerId) this.selfShipId = p.shipId ?? null;
    }
  }

  // ---------- one fixed client step = one input ----------
  step(buttons) {
    const input = { seq: ++this.seq, buttons };
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift(); // server gone quiet; don't grow forever
    // Each packet carries the newest input plus the previous ones → a dropped packet costs nothing.
    this.conn.sendRaw(this.codec.encodeInputs(this.pending.slice(-INPUT_REDUNDANCY)));

    if (this.prediction && this.me && !this.me.destroyed) {
      this.me.prevPos.copyFrom(this.me.pos);
      this.me.prevAngle = this.me.angle;
      const controls = buttonsToControls(buttons);
      if (stepShipMotion(this.me, controls, DT, this.bounds)) this.#fireLocally(input.seq);
    }

    for (const [seq, b] of this.predictedBullets) {
      b.prevPos.copyFrom(b.pos);
      b.pos.addScaledInPlace(b.vel, DT);
      this.#wrap(b.pos);
      b.ttl -= DT;
      if (b.ttl <= 0) this.predictedBullets.delete(seq);
    }
    this.effects.step(DT);
  }

  #fireLocally(seq) {
    const me = this.me;
    me.fireCooldown = FIRE_COOLDOWN_S;
    const dir = Vector2.fromAngle(me.angle);
    const nose = me.pos.add(dir.scale(me.radius + 10));
    const fast = me.effects.has('bullets');
    const vel = me.vel.add(dir.scale(fast ? BULLET_SPEEDS.fast : BULLET_SPEEDS.normal));
    this.predictedBullets.set(seq, {
      kind: 'bullet',
      id: `p${seq}`,
      pos: nose,
      prevPos: nose.clone(),
      vel,
      angle: Math.atan2(vel.y, vel.x),
      prevAngle: Math.atan2(vel.y, vel.x),
      fast,
      radius: 3,
      alive: true,
      ttl: BULLET_TTL,
      bornAt: performance.now(),
      confirmed: false,
    });
    this.#emitNow({ type: 'fired', x: nose.x, y: nose.y, shipId: me.id, fast });
  }

  // ---------- snapshots ----------
  receive(data) {
    let snap;
    try {
      snap = this.codec.decodeSnapshot(data);
    } catch (err) {
      return console.warn('[net] bad snapshot', err.message);
    }
    const now = performance.now();
    if (this.latest && snap.tick <= this.latest.tick) return; // late/duplicate
    if (this.latest) this.stats.snapshotsMissed += snap.tick - this.latest.tick - 1;

    snap.recvAt = now;
    snap.byId = new Map(snap.entities.map((e) => [e.id, e]));
    this.snapshots.push(snap);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.latest = snap;
    this.stats.serverTick = snap.tick;

    // Server clock estimate: the earliest arrival is the least delayed one. Track the minimum,
    // and creep upward slowly so a lasting change in latency is followed too.
    const base = now - snap.tick * TICK_MS;
    if (this.tickBase === null || base < this.tickBase) this.tickBase = base;
    else this.tickBase += (base - this.tickBase) * 0.02;

    for (const event of snap.events) this.pendingEvents.push({ tick: snap.tick, event });
    this.#reconcile(snap);
    this.#confirmBullets(snap);
  }

  #reconcile(snap) {
    const server = this.selfShipId ? snap.byId.get(this.selfShipId) : null;
    if (!server) return;
    if (!this.me) this.me = makeShip(server);

    const me = this.me;
    const before = { x: me.pos.x, y: me.pos.y };
    applyServerShip(me, server);
    this.pending = this.pending.filter((i) => i.seq > snap.ack);

    if (this.prediction && !me.destroyed) {
      // Replay every input the server hasn't processed yet, on top of its authoritative state.
      for (const input of this.pending) {
        const wantsFire = stepShipMotion(me, buttonsToControls(input.buttons), DT, this.bounds);
        if (wantsFire) me.fireCooldown = FIRE_COOLDOWN_S;
      }
    }

    // How far did the truth move us? 0 = prediction was perfect.
    let dx = before.x - me.pos.x;
    let dy = before.y - me.pos.y;
    dx -= Math.round(dx / this.bounds.width) * this.bounds.width; // through the arena wrap
    dy -= Math.round(dy / this.bounds.height) * this.bounds.height;
    const correction = Math.hypot(dx, dy);
    this.stats.lastCorrection = correction;
    this.history.correction.push(correction);

    if (!this.prediction) {
      me.prevPos.copyFrom(me.pos);
      this.smooth.x = this.smooth.y = 0;
    } else if (correction > TELEPORT_PX || me.destroyed) {
      this.smooth.x = this.smooth.y = 0; // respawn / big desync: snap
      me.prevPos.copyFrom(me.pos);
    } else {
      // Keep drawing where we were; the offset decays toward the corrected position.
      this.smooth.x += dx;
      this.smooth.y += dy;
      me.prevPos.x -= dx;
      me.prevPos.y -= dy;
    }
  }

  #confirmBullets(snap) {
    const mine = new Set();
    for (const e of snap.entities) {
      if (e.kind === 'bullet' && e.owner === this.selfShipId) mine.add(e.spawnSeq);
    }
    const now = performance.now();
    for (const [seq, b] of this.predictedBullets) {
      if (mine.has(seq)) b.confirmed = true;
      else if (b.confirmed)
        this.predictedBullets.delete(seq); // server's bullet is gone: it hit something
      else if (now - b.bornAt > this.stats.rttMs + 400) this.predictedBullets.delete(seq); // never spawned
    }
  }

  // ---------- render time ----------
  /** Fractional server tick we are drawing remote entities at. */
  renderTick(now = performance.now()) {
    if (this.tickBase === null) return 0;
    return (now - this.tickBase) / TICK_MS - this.interpDelayMs / TICK_MS;
  }

  /** Remote entities at render time (or the raw latest snapshot without interpolation). */
  #remoteEntities(now) {
    if (!this.latest) return [];
    if (!this.interpolation) return this.latest.entities.map((e) => ({ e, from: e, t: 1 }));

    const rt = this.renderTick(now);
    let a = this.snapshots[0];
    let b = this.snapshots[this.snapshots.length - 1];
    for (let i = this.snapshots.length - 1; i > 0; i--) {
      if (this.snapshots[i - 1].tick <= rt) {
        a = this.snapshots[i - 1];
        b = this.snapshots[i];
        break;
      }
    }
    const t = b.tick === a.tick ? 1 : Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick)));
    // Entities that exist in b; if they also existed in a, blend. (Gone-in-b entities vanish;
    // new-in-b entities appear at their first known position.)
    return b.entities.map((e) => ({ e, from: a.byId.get(e.id) ?? e, t }));
  }

  /** Dispatch the events whose tick the interpolated picture has reached. */
  flushEvents(now = performance.now()) {
    const rt = this.interpolation ? this.renderTick(now) : Infinity;
    while (this.pendingEvents.length && this.pendingEvents[0].tick <= rt + 0.5) {
      const { event } = this.pendingEvents.shift();
      if (event.type === 'fired' && event.shipId === this.selfShipId && this.prediction) continue; // already played
      this.#emitNow(event);
    }
  }

  #emitNow(event) {
    if (event.type === 'exploded') {
      const ship = event.kind === 'ship';
      this.effects.spawn(
        new Explosion({
          x: event.x,
          y: event.y,
          color: ship ? '#ff7a1a' : '#c8b49a',
          count: ship ? 60 : 10 + (event.size ?? 2) * 8,
          speed: ship ? 150 : 80 + (event.size ?? 2) * 50,
        }),
      );
    }
    this.bus.dispatchEvent(new CustomEvent(event.type, { detail: event }));
  }

  /** A drawWorld()-compatible view: interpolated remotes + predicted self + predicted bullets + effects. */
  renderWorld(now = performance.now(), frameDt = 0) {
    const decay = Math.exp(-frameDt / SMOOTH_TAU_S);
    this.smooth.x *= decay;
    this.smooth.y *= decay;

    const views = [];
    for (const { e, from, t } of this.#remoteEntities(now)) {
      const own = this.prediction && e.id === this.selfShipId;
      const ownBullet =
        this.prediction &&
        e.kind === 'bullet' &&
        e.owner === this.selfShipId &&
        this.predictedBullets.has(e.spawnSeq);
      if (own || ownBullet) continue;
      views.push(toView(lerpEntity(from, e, t, this.bounds), this.names));
    }
    const self = this.selfView();
    if (self && this.prediction) views.push(self);
    if (this.prediction) views.push(...this.predictedBullets.values());

    const smooth = this.smooth;
    const effects = this.effects;
    return {
      width: this.bounds.width,
      height: this.bounds.height,
      *ofKind(kind) {
        if (kind === 'explosion') {
          yield* effects.ofKind('explosion');
          return;
        }
        for (const v of views) {
          if (v.kind !== kind) continue;
          if (v === self) {
            // draw the predicted ship shifted by the decaying correction offset
            yield { ...v, pos: v.pos.add(smooth), prevPos: v.prevPos.add(smooth) };
          } else yield v;
        }
      },
    };
  }

  /** The predicted ship as a drawable/HUD-able object. */
  selfView() {
    const me = this.me;
    if (!me) return null;
    return Object.assign(me, { name: this.names.get(me.id) ?? 'me' });
  }

  sample(now) {
    const h = this.history;
    h.rtt.push(this.stats.rttMs);
    h.age.push(this.latest ? now - this.latest.recvAt : 0);
    h.pending.push(this.pending.length);
    for (const k of Object.keys(h)) if (h[k].length > 120) h[k].splice(0, h[k].length - 120);
  }

  #wrap(p) {
    if (p.x < 0) p.x += this.bounds.width;
    else if (p.x >= this.bounds.width) p.x -= this.bounds.width;
    if (p.y < 0) p.y += this.bounds.height;
    else if (p.y >= this.bounds.height) p.y -= this.bounds.height;
  }
}

// ---------- helpers ----------

function makeShip(s) {
  const pos = new Vector2(s.x, s.y);
  return {
    kind: 'ship',
    id: s.id,
    pos,
    prevPos: pos.clone(),
    vel: new Vector2(s.vx, s.vy),
    angle: s.angle,
    prevAngle: s.angle,
    radius: 18,
    alive: true,
    maxHp: 100,
    effects: new Map(),
    invulnerableFor: 0,
    fireCooldown: 0,
    thrusting: false,
  };
}

/** Authoritative fields from the snapshot onto our predicted ship. */
function applyServerShip(me, s) {
  me.pos.set(s.x, s.y);
  me.vel.set(s.vx, s.vy);
  me.angle = s.angle;
  me.hp = s.hp;
  me.score = s.score;
  me.deaths = s.deaths;
  me.destroyed = s.destroyed;
  me.respawnIn = s.respawnIn;
  me.thrusting = s.thrusting;
  me.hitFlash = s.hitFlash ? 0.1 : 0;
  me.invulnerableFor = s.invulnerable;
  me.fireCooldown = s.fireCooldown;
  me.effects.clear();
  if (s.speed > 0) me.effects.set('speed', s.speed);
  if (s.bullets > 0) me.effects.set('bullets', s.bullets);
}

function lerpAngle(a, b, t) {
  let d = b - a;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return a + d * t;
}

function lerpEntity(a, b, t, bounds) {
  if (a === b || t >= 1) return b;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  // through the wrap: don't streak across the whole arena
  if (Math.abs(dx) > bounds.width / 2 || Math.abs(dy) > bounds.height / 2) return b;
  return { ...b, x: a.x + dx * t, y: a.y + dy * t, angle: lerpAngle(a.angle, b.angle, t) };
}

const shapeCache = new Map();
function rockShape(id) {
  let shape = shapeCache.get(id);
  if (!shape) {
    let s = id * 2654435761;
    shape = Array.from({ length: 11 }, () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return 0.75 + (s / 4294967296) * 0.3;
    });
    shapeCache.set(id, shape);
  }
  return shape;
}

/** Snapshot entity → the shape draw.js expects. */
function toView(e, names) {
  const pos = new Vector2(e.x, e.y);
  const base = {
    kind: e.kind,
    id: e.id,
    pos,
    prevPos: pos,
    angle: e.angle,
    prevAngle: e.angle,
    alive: true,
  };
  switch (e.kind) {
    case 'ship': {
      const effects = new Map();
      if (e.speed > 0) effects.set('speed', e.speed);
      if (e.bullets > 0) effects.set('bullets', e.bullets);
      return {
        ...base,
        radius: 18,
        name: names.get(e.id) ?? '?',
        hp: e.hp,
        maxHp: 100,
        destroyed: e.destroyed,
        thrusting: e.thrusting,
        hitFlash: e.hitFlash ? 0.1 : 0,
        invulnerableFor: e.invulnerable,
        effects,
      };
    }
    case 'bullet':
      return {
        ...base,
        radius: 3,
        fast: e.fast,
        angle: Math.atan2(e.vy, e.vx),
        prevAngle: Math.atan2(e.vy, e.vx),
      };
    case 'asteroid':
      return {
        ...base,
        size: e.size,
        radius: ASTEROID_RADIUS[e.size],
        homing: e.seeker ? {} : null,
        hitFlash: e.hitFlash ? 0.1 : 0,
        shape: rockShape(e.id),
      };
    case 'pickup':
      return {
        ...base,
        radius: 12,
        pickup: { effect: e.effect },
        lifetime: 15,
        age: 15 - e.lifeLeft,
      };
    default:
      return base;
  }
}
