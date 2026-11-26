// Real-time protocol shared by client and server (Lab 5).
//
// Control messages (join, chat, ping, netsim, …) stay JSON text frames — rare, human-readable.
// The hot path — INPUTS up (30/s per client) and SNAPSHOTS down (30/s per client) — goes through
// a codec: codec-binary.js (DataView, default) or codec-json.js (for comparison).

export const TICK_RATE = 30; // server simulation + snapshot rate, Hz
export const DT = 1 / TICK_RATE; // one input = one fixed step of DT, on client AND server
export const INPUT_REDUNDANCY = 3; // every input packet repeats the last N inputs (survives drops)
export const MAX_INPUT_QUEUE = 8; // server: inputs buffered per player beyond this are dropped

// ---------- inputs ----------
export const BUTTON = Object.freeze({ left: 1, right: 2, thrust: 4, fire: 8 });

export function controlsToButtons(c) {
  return (
    (c.left ? BUTTON.left : 0) |
    (c.right ? BUTTON.right : 0) |
    (c.thrust ? BUTTON.thrust : 0) |
    (c.fire ? BUTTON.fire : 0)
  );
}

export function buttonsToControls(b) {
  return {
    left: (b & BUTTON.left) !== 0,
    right: (b & BUTTON.right) !== 0,
    thrust: (b & BUTTON.thrust) !== 0,
    fire: (b & BUTTON.fire) !== 0,
  };
}

/** Server-side validation: the client is not trusted. */
export function isValidInput(i) {
  return (
    Number.isInteger(i?.seq) &&
    i.seq > 0 &&
    i.seq <= 0xffffffff &&
    Number.isInteger(i.buttons) &&
    i.buttons >= 0 &&
    i.buttons <= 15
  );
}

// ---------- snapshots ----------
export const KIND = Object.freeze({ ship: 1, bullet: 2, asteroid: 3, pickup: 4 });
export const KIND_NAME = Object.freeze({ 1: 'ship', 2: 'bullet', 3: 'asteroid', 4: 'pickup' });
export const EFFECTS = Object.freeze(['speed', 'bullets', 'repair']);

/**
 * Plain-data view of the world — what a snapshot carries. Full precision here;
 * the binary codec quantizes (angle → Int16, timers → ms, bullet velocity → Int16).
 */
export function snapshotEntities(world) {
  const out = [];
  for (const e of world) {
    if (!e.alive) continue;
    const base = { id: e.id, kind: e.kind, x: e.pos.x, y: e.pos.y, angle: e.angle };
    switch (e.kind) {
      case 'ship':
        out.push({
          ...base,
          vx: e.vel.x,
          vy: e.vel.y,
          hp: e.hp,
          score: e.score,
          deaths: e.deaths,
          destroyed: e.destroyed,
          thrusting: e.thrusting,
          hitFlash: e.hitFlash > 0,
          speed: e.effects.get('speed') ?? 0,
          bullets: e.effects.get('bullets') ?? 0,
          invulnerable: e.invulnerableFor,
          respawnIn: Math.max(0, e.respawnIn),
          fireCooldown: e.fireCooldown,
        });
        break;
      case 'bullet':
        out.push({
          ...base,
          vx: e.vel.x,
          vy: e.vel.y,
          owner: e.ownerId,
          spawnSeq: e.spawnSeq,
          fast: e.fast,
        });
        break;
      case 'asteroid':
        out.push({ ...base, size: e.size, seeker: Boolean(e.homing), hitFlash: e.hitFlash > 0 });
        break;
      case 'pickup':
        out.push({ ...base, effect: e.pickup.effect, lifeLeft: Math.max(0, e.lifetime - e.age) });
        break;
      // explosions are not sent: clients make their own from 'exploded' events
    }
  }
  return out;
}

// ---------- events (things that happen once: sounds, particles, popups) ----------
export const EVENT_TYPES = Object.freeze([
  'fired',
  'hit',
  'exploded',
  'scored',
  'pickup',
  'respawned',
]);

/** Collects the world's events during a tick, in a shape every codec can carry. */
export function collectEvents(world) {
  const events = [];
  for (const type of EVENT_TYPES) {
    world.addEventListener(type, (e) => events.push({ type, ...e.detail }));
  }
  return events;
}
