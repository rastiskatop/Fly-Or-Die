import { Vector2 } from '@flyordie/shared/sim/vector.ts';
import { reconcile } from './reconcile.ts';
import { RemoteViews, createDrawLists, clearDrawLists, type DrawLists } from './remote-views.ts';
import { perf } from '../perf.ts';
import { World } from '@flyordie/shared/sim/world.ts';
import { Explosion } from '@flyordie/shared/sim/explosion.ts';
import {
  stepShipMotion,
  FIRE_COOLDOWN_S,
  BULLET_SPEEDS,
  type Bounds,
  type ShipEffect,
  type ShipMotionState,
} from '@flyordie/shared/sim/ship.ts';
import {
  TICK_RATE,
  DT,
  INPUT_REDUNDANCY,
  buttonsToControls,
  type EntityState,
  type Input,
  type ShipState,
  type Snapshot,
} from '@flyordie/shared/net/protocol.ts';
import { codecFor, type AnyCodec } from '@flyordie/shared/net/codec.ts';
import { decodeSnapshot, SnapshotPool } from '@flyordie/shared/net/codec-binary.ts';
import type { CodecName, RosterPlayer } from '@flyordie/shared/net/messages.ts';
import { Bus } from '@flyordie/shared/bus.ts';
import type { GameEvent, GameEvents } from '@flyordie/shared/sim/events.ts';
import { asSeq, type EntityId, type Seq } from '@flyordie/shared/ids.ts';
import type { Connection } from './connection.ts';
import type {
  Drawable,
  DrawableBullet,
  DrawableKind,
  DrawableShip,
  RenderWorld,
} from '../render/types.ts';
import type { HudPlayer } from '../render/hud.ts';

const TICK_MS = 1000 / TICK_RATE;
const SMOOTH_TAU_S = 0.035; // correction smoothing time constant: ~95% gone after 100 ms
const TELEPORT_PX = 120; // corrections bigger than this (respawn, wrap) snap instead of smoothing
const BULLET_TTL = 1.2;
// How much history to keep: what the interpolation delay needs, plus a margin for jitter/loss.
// Lab 7: it was a fixed 60 snapshots (2 s). The young generation here is collected by V8's
// minor mark-sweep, which PROMOTES whatever is alive at that moment — so every kept snapshot's
// entity objects went straight to the old generation. Measured as the cause of the major GCs.
const HISTORY_MARGIN_MS = 150;
const MIN_SNAPSHOTS = 4;

/** A received snapshot plus when it arrived. (No per-snapshot Map: see RemoteViews.) */
interface SnapSlot extends Snapshot {
  readonly recvAt: number;
}

/**
 * Our predicted plane: everything stepShipMotion needs (mutable), plus what the renderer and HUD
 * read. It isn't declared as a DrawableShip/HudPlayer — it just has the right shape, and being
 * mutable it is assignable to those read-only views (checked where it's used).
 */
type PredictedShip = ShipMotionState & {
  readonly kind: 'ship';
  readonly id: EntityId;
  prevPos: Vector2;
  prevAngle: number;
  hp: number;
  score: number;
  deaths: number;
  destroyed: boolean;
  respawnIn: number;
  hitFlash: number;
  name: string;
  readonly radius: number;
  readonly alive: boolean;
  readonly maxHp: number;
};

// Compile-time proof that a PredictedShip can be drawn and shown in the HUD.
const _drawable = (s: PredictedShip): DrawableShip & HudPlayer => s;
void _drawable;

interface PredictedBullet extends DrawableBullet {
  readonly id: string;
  pos: Vector2;
  prevPos: Vector2;
  readonly vel: Vector2;
  ttl: number;
  readonly bornAt: number;
  confirmed: boolean;
}

export interface NetStats {
  rttMs: number;
  lastCorrection: number;
  snapshotsMissed: number;
  bytesInPerS: number;
  bytesOutPerS: number;
  serverTick: number;
}

export interface NetHistory {
  readonly rtt: number[];
  readonly age: number[];
  readonly correction: number[];
  readonly pending: number[];
}

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
  readonly conn: Connection;
  readonly codec: AnyCodec;
  readonly codecName: CodecName;
  readonly bounds: Bounds;
  selfPlayerId: string | null;
  selfShipId: EntityId | null = null;
  readonly names = new Map<EntityId, string>(); // shipId -> pilot name

  prediction: boolean;
  interpolation: boolean;
  interpDelayMs: number;
  chaos = false;

  seq = 0;
  pending: Input[] = []; // unacknowledged inputs
  readonly snapshots: SnapSlot[] = [];
  latest: SnapSlot | null = null;
  tickBase: number | null = null; // client time (ms) at which server tick 0 "happened"

  me: PredictedShip | null = null;
  smooth = Vector2.ZERO;
  readonly predictedBullets = new Map<Seq, PredictedBullet>();
  readonly pendingEvents: { readonly tick: number; readonly event: GameEvent }[] = [];

  // ---- render path state, reused every frame (Lab 7: no per-frame allocation) ----
  readonly #remote = new RemoteViews();
  /** Entity objects of snapshots that left the history, refilled by the next decode (Lab 7). */
  readonly snapshotPool = new SnapshotPool();
  readonly #lists: DrawLists = createDrawLists();
  #selfView:
    | (Omit<PredictedShip, 'pos' | 'prevPos'> & {
        pos: { x: number; y: number };
        prevPos: { x: number; y: number };
      })
    | null = null;
  readonly #selfPos = { x: 0, y: 0 };
  readonly #selfPrev = { x: 0, y: 0 };
  /** Our own ship and own predicted bullets are drawn from prediction, not from the snapshot. */
  readonly #skipPredicted = (e: EntityState): boolean =>
    this.prediction &&
    (e.id === this.selfShipId ||
      (e.kind === 'bullet' &&
        e.owner === this.selfShipId &&
        this.predictedBullets.has(e.spawnSeq)));
  #renderWorld: RenderWorld | null = null; // created on first use (bounds are set in the constructor)

  /** Explosions are purely visual: a local World holding only Explosion entities. */
  readonly effects: World;
  /** The same typed bus audio.ts and hud.ts subscribe to offline. */
  readonly events = new Bus<GameEvents>();

  readonly stats: NetStats = {
    rttMs: 0,
    lastCorrection: 0,
    snapshotsMissed: 0,
    bytesInPerS: 0,
    bytesOutPerS: 0,
    serverTick: 0,
  };
  readonly history: NetHistory = { rtt: [], age: [], correction: [], pending: [] };

  constructor({
    conn,
    codec,
    bounds,
    selfPlayerId,
    flags = {},
  }: {
    conn: Connection;
    codec: CodecName;
    bounds: Bounds;
    selfPlayerId: string | null;
    flags?: { prediction?: boolean; interpolation?: boolean; interpDelayMs?: number };
  }) {
    this.conn = conn;
    this.codec = codecFor(codec);
    this.codecName = codec;
    this.bounds = bounds;
    this.selfPlayerId = selfPlayerId;
    this.prediction = flags.prediction ?? true;
    this.interpolation = flags.interpolation ?? true;
    this.interpDelayMs = flags.interpDelayMs ?? 100;
    this.effects = new World({ width: bounds.width, height: bounds.height, seed: 1 });
  }

  get entityCount(): number {
    return this.latest?.entities.length ?? 0;
  }

  // ---------- roster → which ship is mine ----------
  setRoster(players: readonly RosterPlayer[]): void {
    this.names.clear();
    for (const p of players) {
      if (p.shipId !== undefined) this.names.set(p.shipId, p.name);
      if (p.id === this.selfPlayerId) this.selfShipId = p.shipId ?? null;
    }
  }

  // ---------- one fixed client step = one input ----------
  step(buttons: number): void {
    const input: Input = { seq: asSeq(++this.seq), buttons };
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift(); // server gone quiet; don't grow forever
    // Each packet carries the newest input plus the previous ones → a dropped packet costs nothing.
    this.conn.sendRaw(this.codec.encodeInputs(this.pending.slice(-INPUT_REDUNDANCY)));

    const me = this.me;
    if (this.prediction && me && !me.destroyed) {
      me.prevPos = me.pos;
      me.prevAngle = me.angle;
      if (stepShipMotion(me, buttonsToControls(buttons), DT, this.bounds))
        this.#fireLocally(me, input.seq);
    }

    for (const [seq, b] of this.predictedBullets) {
      b.prevPos = b.pos;
      b.pos = this.#wrap(b.pos.addScaled(b.vel, DT));
      b.ttl -= DT;
      if (b.ttl <= 0) this.predictedBullets.delete(seq);
    }
    this.effects.step(DT);
  }

  #fireLocally(me: PredictedShip, seq: Seq): void {
    me.fireCooldown = FIRE_COOLDOWN_S;
    const dir = Vector2.fromAngle(me.angle);
    const nose = me.pos.add(dir.scale(me.radius + 10));
    const fast = me.effects.has('bullets');
    const vel = me.vel.add(dir.scale(fast ? BULLET_SPEEDS.fast : BULLET_SPEEDS.normal));
    const angle = Math.atan2(vel.y, vel.x);
    this.predictedBullets.set(seq, {
      kind: 'bullet',
      id: `p${seq}`,
      pos: nose,
      prevPos: nose,
      vel,
      angle,
      prevAngle: angle,
      fast,
      alive: true,
      ttl: BULLET_TTL,
      bornAt: performance.now(),
      confirmed: false,
    });
    this.#emitNow({ type: 'fired', x: nose.x, y: nose.y, shipId: me.id, fast });
  }

  // ---------- snapshots ----------
  /** A binary frame from the Connection (binary codec). */
  receiveBinary(data: ArrayBuffer): void {
    if (this.codec.name !== 'binary') return;
    try {
      perf.begin('decode');
      const snap = decodeSnapshot(new Uint8Array(data), this.snapshotPool);
      perf.end('decode');
      this.receive(snap);
    } catch (err: unknown) {
      console.warn('[net] bad snapshot', err instanceof Error ? err.message : err);
    }
  }

  /** A decoded, validated snapshot (from either codec). */
  receive(snap: Snapshot): void {
    const now = performance.now();
    if (this.latest && snap.tick <= this.latest.tick) return; // late/duplicate
    if (this.latest) this.stats.snapshotsMissed += snap.tick - this.latest.tick - 1;

    const slot: SnapSlot = { ...snap, recvAt: now };
    this.snapshots.push(slot);
    const keep = Math.max(
      MIN_SNAPSHOTS,
      Math.ceil((this.interpDelayMs + HISTORY_MARGIN_MS) / TICK_MS),
    );
    while (this.snapshots.length > keep) {
      const old = this.snapshots.shift();
      // Binary-decoded entities go back to the pool (JSON ones have their own shapes: let them go).
      if (old && this.codec.name === 'binary') this.snapshotPool.release(old.entities);
    }
    this.latest = slot;
    this.stats.serverTick = snap.tick;

    // Server clock estimate: the earliest arrival is the least delayed one. Track the minimum,
    // and creep upward slowly so a lasting change in latency is followed too.
    const base = now - snap.tick * TICK_MS;
    if (this.tickBase === null || base < this.tickBase) this.tickBase = base;
    else this.tickBase += (base - this.tickBase) * 0.02;

    for (const event of snap.events) this.pendingEvents.push({ tick: snap.tick, event });
    perf.begin('reconcile');
    this.#reconcile(slot);
    perf.end('reconcile');
    this.#confirmBullets(slot);
  }

  #reconcile(snap: SnapSlot): void {
    let server: EntityState | undefined;
    for (const e of snap.entities) if (e.id === this.selfShipId) server = e; // once per snapshot
    if (server?.kind !== 'ship') return;
    const me = (this.me ??= makeShip(server));

    const before = me.pos;
    applyServerShip(me, server);
    // Replay every input the server hasn't processed yet, on top of its authoritative state;
    // the correction says how far the truth moved us (0 = the prediction was perfect).
    const { pending, dx, dy, correction } = reconcile(
      me,
      before,
      this.pending,
      snap.ack,
      this.bounds,
      this.prediction && !me.destroyed,
    );
    this.pending = pending;
    this.stats.lastCorrection = correction;
    this.history.correction.push(correction);

    if (!this.prediction || correction > TELEPORT_PX || me.destroyed) {
      this.smooth = Vector2.ZERO; // off, respawn or big desync: snap
      me.prevPos = me.pos;
    } else {
      // Keep drawing where we were; the offset decays toward the corrected position.
      const delta = new Vector2(dx, dy);
      this.smooth = this.smooth.add(delta);
      me.prevPos = me.prevPos.sub(delta);
    }
  }

  #confirmBullets(snap: SnapSlot): void {
    const mine = new Set<number>();
    for (const e of snap.entities)
      if (e.kind === 'bullet' && e.owner === this.selfShipId) mine.add(e.spawnSeq);
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
  renderTick(now = performance.now()): number {
    if (this.tickBase === null) return 0;
    return (now - this.tickBase) / TICK_MS - this.interpDelayMs / TICK_MS;
  }

  /** Dispatch the events whose tick the interpolated picture has reached. */
  flushEvents(now = performance.now()): void {
    const rt = this.interpolation ? this.renderTick(now) : Infinity;
    for (;;) {
      const next = this.pendingEvents[0];
      if (!next || next.tick > rt + 0.5) break;
      this.pendingEvents.shift();
      const { event } = next;
      if (event.type === 'fired' && event.shipId === this.selfShipId && this.prediction) continue; // already played
      this.#emitNow(event);
    }
  }

  /** Re-announce a snapshot event on the typed bus. Exhaustive: a new event type is a compile error. */
  #emitNow(event: GameEvent): void {
    if (event.type === 'exploded') {
      const ship = event.kind === 'ship';
      const size = event.kind === 'asteroid' ? event.size : 2;
      this.effects.spawn(
        new Explosion({
          x: event.x,
          y: event.y,
          color: ship ? '#ff7a1a' : '#c8b49a',
          count: ship ? 60 : 10 + size * 8,
          speed: ship ? 150 : 80 + size * 50,
        }),
      );
    }
    const { events } = this;
    switch (event.type) {
      case 'fired':
        return events.emit('fired', event);
      case 'hit':
        return events.emit('hit', event);
      case 'exploded':
        return events.emit('exploded', event);
      case 'scored':
        return events.emit('scored', event);
      case 'pickup':
        return events.emit('pickup', event);
      case 'respawned':
        return events.emit('respawned', event);
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }

  /**
   * What drawWorld draws: interpolated remotes + predicted self + predicted bullets + effects.
   * Allocation-free in steady state (Lab 7): reused view objects and reused per-kind arrays.
   */
  renderWorld(now = performance.now(), frameDt = 0): RenderWorld {
    this.smooth = this.smooth.scale(Math.exp(-frameDt / SMOOTH_TAU_S));
    const lists = this.#lists;
    clearDrawLists(lists);

    const latest = this.latest;
    if (latest) {
      // The two snapshots around render time (interpolation off: just the latest one).
      let a: SnapSlot = latest;
      let b: SnapSlot = latest;
      let t = 1;
      if (this.interpolation) {
        const rt = this.renderTick(now);
        a = this.snapshots[0] ?? latest;
        for (let i = this.snapshots.length - 1; i > 0; i--) {
          const prev = this.snapshots[i - 1];
          const cur = this.snapshots[i];
          if (prev && cur && prev.tick <= rt) {
            a = prev;
            b = cur;
            break;
          }
        }
        t = b.tick === a.tick ? 1 : Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick)));
      }
      this.#remote.update(a.entities, b.entities, t, this.bounds, this.#skipPredicted, lists);
    }

    const me = this.me;
    if (me && this.prediction) {
      // the predicted ship, shifted by the decaying correction offset (one reused object)
      const v = (this.#selfView ??= { ...me, pos: this.#selfPos, prevPos: this.#selfPrev });
      Object.assign(v, me); // copies the current hp/angle/effects…; pos/prevPos are re-pointed below
      v.pos = this.#selfPos;
      v.prevPos = this.#selfPrev;
      this.#selfPos.x = me.pos.x + this.smooth.x;
      this.#selfPos.y = me.pos.y + this.smooth.y;
      this.#selfPrev.x = me.prevPos.x + this.smooth.x;
      this.#selfPrev.y = me.prevPos.y + this.smooth.y;
      lists.ship.push(v);
    }
    if (this.prediction) for (const b of this.predictedBullets.values()) lists.bullet.push(b);
    for (const e of this.effects.ofKind('explosion')) lists.explosion.push(e);
    return (this.#renderWorld ??= {
      width: this.bounds.width,
      height: this.bounds.height,
      ofKind: (kind: DrawableKind): readonly Drawable[] => this.#lists[kind],
    });
  }

  /** The predicted ship as a drawable/HUD-able object (null before our first snapshot). */
  selfView(): PredictedShip | null {
    const me = this.me;
    if (me) me.name = this.names.get(me.id) ?? 'me';
    return me;
  }

  sample(now: number): void {
    const h = this.history;
    h.rtt.push(this.stats.rttMs);
    h.age.push(this.latest ? now - this.latest.recvAt : 0);
    h.pending.push(this.pending.length);
    for (const series of [h.rtt, h.age, h.correction, h.pending])
      if (series.length > 120) series.splice(0, series.length - 120);
  }

  #wrap(p: Vector2): Vector2 {
    let { x, y } = p;
    if (x < 0) x += this.bounds.width;
    else if (x >= this.bounds.width) x -= this.bounds.width;
    if (y < 0) y += this.bounds.height;
    else if (y >= this.bounds.height) y -= this.bounds.height;
    return x === p.x && y === p.y ? p : new Vector2(x, y);
  }
}

// ---------- helpers ----------

function effectsOf(s: ShipState): Map<ShipEffect, number> {
  const effects = new Map<ShipEffect, number>();
  if (s.speed > 0) effects.set('speed', s.speed);
  if (s.bullets > 0) effects.set('bullets', s.bullets);
  return effects;
}

function makeShip(s: ShipState): PredictedShip {
  const pos = new Vector2(s.x, s.y);
  return {
    kind: 'ship',
    id: s.id,
    pos,
    prevPos: pos,
    vel: new Vector2(s.vx, s.vy),
    angle: s.angle,
    prevAngle: s.angle,
    radius: 18,
    alive: true,
    maxHp: 100,
    hp: s.hp,
    score: s.score,
    deaths: s.deaths,
    destroyed: s.destroyed,
    respawnIn: s.respawnIn,
    hitFlash: 0,
    effects: effectsOf(s),
    invulnerableFor: s.invulnerable,
    fireCooldown: s.fireCooldown,
    thrusting: s.thrusting,
    name: 'me',
  };
}

/** Authoritative fields from the snapshot onto our predicted ship. */
function applyServerShip(me: PredictedShip, s: ShipState): void {
  me.pos = new Vector2(s.x, s.y);
  me.vel = new Vector2(s.vx, s.vy);
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
  for (const [k, v] of effectsOf(s)) me.effects.set(k, v);
}
