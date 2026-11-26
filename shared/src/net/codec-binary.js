import { KIND, KIND_NAME, EFFECTS } from './protocol.js';

/*
 * ============================ BINARY PROTOCOL v1 — SPEC ============================
 * All multi-byte numbers are LITTLE-ENDIAN (DataView with littleEndian = true everywhere).
 * Types: u8/u16/u32 unsigned ints, i16 signed, f32 IEEE-754 single.
 *
 * INPUTS  (client → server), binary frame
 *   off size
 *   0   u8   msgType = 1
 *   1   u8   count n (1..8) — the newest input and up to n−1 previous ones (redundancy vs drops)
 *   2   n × { u32 seq, u8 buttons }      buttons: bit0 left, bit1 right, bit2 thrust, bit3 fire
 *   total = 2 + 5n bytes
 *
 * SNAPSHOT (server → client), binary frame
 *   0   u8   msgType = 2
 *   1   u8   version = 1
 *   2   u32  tick                 server tick this state belongs to
 *   6   u32  ack                  last input seq the server applied for THIS client
 *   10  u16  entityCount
 *   12  u8   eventCount
 *   13  entities…, then events…
 *
 *   entity common header (13 bytes)
 *     u16 id · u8 kind (1 ship, 2 bullet, 3 asteroid, 4 pickup) · f32 x · f32 y
 *     i16 angle in 1/10000 rad  (range ±π·10000 = ±31416 fits Int16 → precision 0.0001 rad)
 *   ship      (+23 → 36 bytes)
 *     f32 vx · f32 vy · u8 hp · u8 flags (bit0 destroyed, bit1 thrusting, bit2 hitFlash)
 *     u16 score · u16 deaths · u16 speedMs · u16 bulletsMs · u16 invulnerableMs · u16 respawnMs
 *     u8 fireCooldownMs (0..255)
 *   bullet    (+11 → 24 bytes)
 *     i16 vx · i16 vy (px/s, rounded) · u16 owner · u32 spawnSeq · u8 flags (bit0 fast)
 *   asteroid  (+2 → 15 bytes)    u8 size · u8 flags (bit0 seeker, bit1 hitFlash)
 *   pickup    (+2 → 15 bytes)    u8 effect (0 speed, 1 bullets, 2 repair) · u8 lifeLeft (1/10 s)
 *
 *   event (13 bytes)
 *     u8 type · f32 x · f32 y · u16 a · u16 b
 *     1 fired     a=shipId b=fast        2 hit ship    a=shipId b=damage
 *     3 hit rock  a=rockId               4 ship down   a=shipId
 *     5 rock down b=size                 6 scored      a=shipId b=points
 *     7 pickup    a=shipId b=effect      8 respawned   a=shipId
 * ==================================================================================
 */

export const MSG = Object.freeze({ INPUTS: 1, SNAPSHOT: 2 });
export const VERSION = 1;
const LE = true;
const ANGLE_SCALE = 10000;
const COMMON = 13;
const SIZE = { ship: COMMON + 23, bullet: COMMON + 11, asteroid: COMMON + 2, pickup: COMMON + 2 };
const EVENT_SIZE = 13;

const ms = (s) => Math.min(0xffff, Math.max(0, Math.round(s * 1000)));
const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
/** Rocks spin forever, so angles can be any size: bring them into (-π, π] before quantizing. */
const wrapAngle = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

function view(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  // Node Buffer / Uint8Array: a view into a (possibly larger, shared) ArrayBuffer — respect the offset!
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

// ---------- inputs ----------

export function encodeInputs(inputs) {
  const buf = new ArrayBuffer(2 + 5 * inputs.length);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUTS);
  v.setUint8(1, inputs.length);
  let o = 2;
  for (const { seq, buttons } of inputs) {
    v.setUint32(o, seq, LE);
    v.setUint8(o + 4, buttons);
    o += 5;
  }
  return new Uint8Array(buf);
}

export function decodeInputs(data) {
  const v = view(data);
  if (v.byteLength < 2 || v.getUint8(0) !== MSG.INPUTS) throw new Error('not an inputs message');
  const n = v.getUint8(1);
  if (n < 1 || n > 8 || v.byteLength !== 2 + 5 * n) throw new Error('bad inputs length');
  const inputs = [];
  for (let i = 0, o = 2; i < n; i++, o += 5)
    inputs.push({ seq: v.getUint32(o, LE), buttons: v.getUint8(o + 4) });
  return inputs;
}

// ---------- snapshots ----------

const EVENT_CODE = {
  fired: 1,
  hit: 2,
  hitRock: 3,
  explodedShip: 4,
  explodedRock: 5,
  scored: 6,
  pickup: 7,
  respawned: 8,
};

function eventCode(e) {
  if (e.type === 'hit') return e.kind === 'ship' ? EVENT_CODE.hit : EVENT_CODE.hitRock;
  if (e.type === 'exploded')
    return e.kind === 'ship' ? EVENT_CODE.explodedShip : EVENT_CODE.explodedRock;
  return EVENT_CODE[e.type];
}

function eventAB(e) {
  switch (e.type) {
    case 'fired':
      return [e.shipId, e.fast ? 1 : 0];
    case 'hit':
      return e.kind === 'ship' ? [e.id, e.damage ?? 0] : [e.id, 0];
    case 'exploded':
      return e.kind === 'ship' ? [e.shipId, 0] : [0, e.size ?? 0];
    case 'scored':
      return [e.shipId, e.points];
    case 'pickup':
      return [e.shipId, Math.max(0, EFFECTS.indexOf(e.effect))];
    case 'respawned':
      return [e.shipId, 0];
    default:
      return [0, 0];
  }
}

function decodeEvent(code, x, y, a, b) {
  switch (code) {
    case 1:
      return { type: 'fired', x, y, shipId: a, fast: b === 1 };
    case 2:
      return { type: 'hit', kind: 'ship', x, y, id: a, damage: b };
    case 3:
      return { type: 'hit', kind: 'asteroid', x, y, id: a };
    case 4:
      return { type: 'exploded', kind: 'ship', x, y, shipId: a };
    case 5:
      return { type: 'exploded', kind: 'asteroid', x, y, size: b };
    case 6:
      return { type: 'scored', x, y, shipId: a, points: b };
    case 7:
      return { type: 'pickup', x, y, shipId: a, effect: EFFECTS[b] };
    case 8:
      return { type: 'respawned', x, y, shipId: a };
    default:
      return null;
  }
}

export function snapshotSize(snap) {
  let n = 13 + snap.events.length * EVENT_SIZE;
  for (const e of snap.entities) n += SIZE[e.kind] ?? 0;
  return n;
}

export function encodeSnapshot(snap) {
  const entities = snap.entities.filter((e) => SIZE[e.kind]);
  const events = snap.events.filter((e) => eventCode(e)).slice(0, 255);
  const buf = new ArrayBuffer(snapshotSize({ entities, events }));
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint8(1, VERSION);
  v.setUint32(2, snap.tick, LE);
  v.setUint32(6, snap.ack, LE);
  v.setUint16(10, entities.length, LE);
  v.setUint8(12, events.length);
  let o = 13;

  for (const e of entities) {
    v.setUint16(o, e.id, LE);
    v.setUint8(o + 2, KIND[e.kind]);
    v.setFloat32(o + 3, e.x, LE);
    v.setFloat32(o + 7, e.y, LE);
    v.setInt16(o + 11, clampI16(wrapAngle(e.angle) * ANGLE_SCALE), LE);
    o += COMMON;
    switch (e.kind) {
      case 'ship':
        v.setFloat32(o, e.vx, LE);
        v.setFloat32(o + 4, e.vy, LE);
        v.setUint8(o + 8, Math.max(0, Math.min(255, Math.round(e.hp))));
        v.setUint8(o + 9, (e.destroyed ? 1 : 0) | (e.thrusting ? 2 : 0) | (e.hitFlash ? 4 : 0));
        v.setUint16(o + 10, Math.min(0xffff, e.score), LE);
        v.setUint16(o + 12, Math.min(0xffff, e.deaths), LE);
        v.setUint16(o + 14, ms(e.speed), LE);
        v.setUint16(o + 16, ms(e.bullets), LE);
        v.setUint16(o + 18, ms(e.invulnerable), LE);
        v.setUint16(o + 20, ms(e.respawnIn), LE);
        v.setUint8(o + 22, Math.min(255, ms(e.fireCooldown)));
        o += 23;
        break;
      case 'bullet':
        v.setInt16(o, clampI16(e.vx), LE);
        v.setInt16(o + 2, clampI16(e.vy), LE);
        v.setUint16(o + 4, e.owner, LE);
        v.setUint32(o + 6, e.spawnSeq, LE);
        v.setUint8(o + 10, e.fast ? 1 : 0);
        o += 11;
        break;
      case 'asteroid':
        v.setUint8(o, e.size);
        v.setUint8(o + 1, (e.seeker ? 1 : 0) | (e.hitFlash ? 2 : 0));
        o += 2;
        break;
      case 'pickup':
        v.setUint8(o, Math.max(0, EFFECTS.indexOf(e.effect)));
        v.setUint8(o + 1, Math.min(255, Math.round(e.lifeLeft * 10)));
        o += 2;
        break;
    }
  }

  for (const e of events) {
    const [a, b] = eventAB(e);
    v.setUint8(o, eventCode(e));
    v.setFloat32(o + 1, e.x ?? 0, LE);
    v.setFloat32(o + 5, e.y ?? 0, LE);
    v.setUint16(o + 9, a & 0xffff, LE);
    v.setUint16(o + 11, b & 0xffff, LE);
    o += EVENT_SIZE;
  }
  return new Uint8Array(buf);
}

export function decodeSnapshot(data) {
  const v = view(data);
  if (v.getUint8(0) !== MSG.SNAPSHOT) throw new Error('not a snapshot');
  if (v.getUint8(1) !== VERSION) throw new Error(`unsupported snapshot version ${v.getUint8(1)}`);
  const snap = { tick: v.getUint32(2, LE), ack: v.getUint32(6, LE), entities: [], events: [] };
  const count = v.getUint16(10, LE);
  const eventCount = v.getUint8(12);
  let o = 13;

  for (let i = 0; i < count; i++) {
    const kind = KIND_NAME[v.getUint8(o + 2)];
    const e = {
      id: v.getUint16(o, LE),
      kind,
      x: v.getFloat32(o + 3, LE),
      y: v.getFloat32(o + 7, LE),
      angle: v.getInt16(o + 11, LE) / ANGLE_SCALE,
    };
    o += COMMON;
    switch (kind) {
      case 'ship': {
        const flags = v.getUint8(o + 9);
        Object.assign(e, {
          vx: v.getFloat32(o, LE),
          vy: v.getFloat32(o + 4, LE),
          hp: v.getUint8(o + 8),
          destroyed: (flags & 1) !== 0,
          thrusting: (flags & 2) !== 0,
          hitFlash: (flags & 4) !== 0,
          score: v.getUint16(o + 10, LE),
          deaths: v.getUint16(o + 12, LE),
          speed: v.getUint16(o + 14, LE) / 1000,
          bullets: v.getUint16(o + 16, LE) / 1000,
          invulnerable: v.getUint16(o + 18, LE) / 1000,
          respawnIn: v.getUint16(o + 20, LE) / 1000,
          fireCooldown: v.getUint8(o + 22) / 1000,
        });
        o += 23;
        break;
      }
      case 'bullet':
        Object.assign(e, {
          vx: v.getInt16(o, LE),
          vy: v.getInt16(o + 2, LE),
          owner: v.getUint16(o + 4, LE),
          spawnSeq: v.getUint32(o + 6, LE),
          fast: (v.getUint8(o + 10) & 1) !== 0,
        });
        o += 11;
        break;
      case 'asteroid': {
        const flags = v.getUint8(o + 1);
        Object.assign(e, {
          size: v.getUint8(o),
          seeker: (flags & 1) !== 0,
          hitFlash: (flags & 2) !== 0,
        });
        o += 2;
        break;
      }
      case 'pickup':
        Object.assign(e, { effect: EFFECTS[v.getUint8(o)], lifeLeft: v.getUint8(o + 1) / 10 });
        o += 2;
        break;
      default:
        throw new Error(`unknown entity kind at byte ${o - COMMON}`);
    }
    snap.entities.push(e);
  }

  for (let i = 0; i < eventCount; i++, o += EVENT_SIZE) {
    const ev = decodeEvent(
      v.getUint8(o),
      v.getFloat32(o + 1, LE),
      v.getFloat32(o + 5, LE),
      v.getUint16(o + 9, LE),
      v.getUint16(o + 11, LE),
    );
    if (ev) snap.events.push(ev);
  }
  return snap;
}
