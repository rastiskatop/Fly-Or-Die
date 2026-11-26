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

import { asEntityId, asSeq, asTick } from '../ids.ts';
import { isAsteroidSize } from '../sim/asteroid.ts';
import { PICKUP_EFFECTS, type PickupEffect } from '../sim/pickup.ts';
import type { GameEvent } from '../sim/events.ts';
import type { EntityState, EntityStateKind, Input, Snapshot } from './protocol.ts';
import { InputSchema } from './protocol.ts';

export const MSG = Object.freeze({ INPUTS: 1, SNAPSHOT: 2 });
export const VERSION = 1;
const LE = true;
const ANGLE_SCALE = 10000;
const COMMON = 13;
const SIZE: Readonly<Record<EntityStateKind, number>> = {
  ship: COMMON + 23,
  bullet: COMMON + 11,
  asteroid: COMMON + 2,
  pickup: COMMON + 2,
};
const KIND_CODE: Readonly<Record<EntityStateKind, number>> = {
  ship: 1,
  bullet: 2,
  asteroid: 3,
  pickup: 4,
};
const EVENT_SIZE = 13;
const HEADER = 13;

export type BinaryData = ArrayBuffer | Uint8Array;

const ms = (s: number): number => Math.min(0xffff, Math.max(0, Math.round(s * 1000)));
const clampI16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));
/** Rocks spin forever, so angles can be any size: bring them into (-π, π] before quantizing. */
const wrapAngle = (a: number): number => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

function view(data: BinaryData): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  // Node Buffer / Uint8Array: a view into a (possibly larger, shared) ArrayBuffer — respect the offset!
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Throws a descriptive RangeError instead of letting DataView read past the end. */
function need(v: DataView, end: number, what: string): void {
  if (end > v.byteLength)
    throw new RangeError(`truncated ${what}: need ${end} bytes, have ${v.byteLength}`);
}

// ---------- inputs ----------

export function encodeInputs(inputs: readonly Input[]): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(2 + 5 * inputs.length);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUTS);
  v.setUint8(1, inputs.length);
  inputs.forEach(({ seq, buttons }, i) => {
    v.setUint32(2 + i * 5, seq, LE);
    v.setUint8(6 + i * 5, buttons);
  });
  return new Uint8Array(buf);
}

/** Validating decoder: length, type byte, count, and every input through the zod schema. */
export function decodeInputs(data: BinaryData): Input[] {
  const v = view(data);
  if (v.byteLength < 2 || v.getUint8(0) !== MSG.INPUTS) throw new Error('not an inputs message');
  const n = v.getUint8(1);
  if (n < 1 || n > 8 || v.byteLength !== 2 + 5 * n) throw new Error('bad inputs length');
  const inputs: Input[] = [];
  for (let i = 0, o = 2; i < n; i++, o += 5) {
    inputs.push(InputSchema.parse({ seq: v.getUint32(o, LE), buttons: v.getUint8(o + 4) }));
  }
  return inputs;
}

// ---------- events ----------

const EVENT_CODE = {
  fired: 1,
  hitShip: 2,
  hitRock: 3,
  explodedShip: 4,
  explodedRock: 5,
  scored: 6,
  pickup: 7,
  respawned: 8,
} as const;

/** [code, a, b] for one event. Exhaustive: a new event type is a compile error here. */
function encodeEvent(e: GameEvent): readonly [number, number, number] {
  switch (e.type) {
    case 'fired':
      return [EVENT_CODE.fired, e.shipId, e.fast ? 1 : 0];
    case 'hit':
      return e.kind === 'ship'
        ? [EVENT_CODE.hitShip, e.id, e.damage]
        : [EVENT_CODE.hitRock, e.id, 0];
    case 'exploded':
      return e.kind === 'ship'
        ? [EVENT_CODE.explodedShip, e.shipId, 0]
        : [EVENT_CODE.explodedRock, 0, e.size];
    case 'scored':
      return [EVENT_CODE.scored, e.shipId, e.points];
    case 'pickup':
      return [EVENT_CODE.pickup, e.shipId, Math.max(0, PICKUP_EFFECTS.indexOf(e.effect))];
    case 'respawned':
      return [EVENT_CODE.respawned, e.shipId, 0];
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

function effectAt(i: number): PickupEffect {
  const effect = PICKUP_EFFECTS[i];
  if (!effect) throw new RangeError(`bad pickup effect ${i}`);
  return effect;
}

function decodeEvent(code: number, x: number, y: number, a: number, b: number): GameEvent {
  switch (code) {
    case EVENT_CODE.fired:
      return { type: 'fired', x, y, shipId: asEntityId(a), fast: b === 1 };
    case EVENT_CODE.hitShip:
      return { type: 'hit', kind: 'ship', x, y, id: asEntityId(a), damage: b };
    case EVENT_CODE.hitRock:
      return { type: 'hit', kind: 'asteroid', x, y, id: asEntityId(a) };
    case EVENT_CODE.explodedShip:
      return { type: 'exploded', kind: 'ship', x, y, shipId: asEntityId(a) };
    case EVENT_CODE.explodedRock:
      if (!isAsteroidSize(b)) throw new RangeError(`bad asteroid size ${b}`);
      return { type: 'exploded', kind: 'asteroid', x, y, size: b };
    case EVENT_CODE.scored:
      return { type: 'scored', x, y, shipId: asEntityId(a), points: b };
    case EVENT_CODE.pickup:
      return { type: 'pickup', x, y, shipId: asEntityId(a), effect: effectAt(b) };
    case EVENT_CODE.respawned:
      return { type: 'respawned', x, y, shipId: asEntityId(a) };
    default:
      throw new RangeError(`unknown event code ${code}`);
  }
}

// ---------- snapshots ----------

export function snapshotSize(snap: Pick<Snapshot, 'entities' | 'events'>): number {
  let n = HEADER + snap.events.length * EVENT_SIZE;
  for (const e of snap.entities) n += SIZE[e.kind];
  return n;
}

export function encodeSnapshot(snap: Snapshot): Uint8Array<ArrayBuffer> {
  const events = snap.events.slice(0, 255);
  const buf = new ArrayBuffer(snapshotSize({ entities: snap.entities, events }));
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint8(1, VERSION);
  v.setUint32(2, snap.tick, LE);
  v.setUint32(6, snap.ack, LE);
  v.setUint16(10, snap.entities.length, LE);
  v.setUint8(12, events.length);
  let o = HEADER;

  for (const e of snap.entities) {
    v.setUint16(o, e.id, LE);
    v.setUint8(o + 2, KIND_CODE[e.kind]);
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
        break;
      case 'bullet':
        v.setInt16(o, clampI16(e.vx), LE);
        v.setInt16(o + 2, clampI16(e.vy), LE);
        v.setUint16(o + 4, e.owner, LE);
        v.setUint32(o + 6, e.spawnSeq, LE);
        v.setUint8(o + 10, e.fast ? 1 : 0);
        break;
      case 'asteroid':
        v.setUint8(o, e.size);
        v.setUint8(o + 1, (e.seeker ? 1 : 0) | (e.hitFlash ? 2 : 0));
        break;
      case 'pickup':
        v.setUint8(o, Math.max(0, PICKUP_EFFECTS.indexOf(e.effect)));
        v.setUint8(o + 1, Math.min(255, Math.round(e.lifeLeft * 10)));
        break;
      default: {
        const unreachable: never = e;
        return unreachable;
      }
    }
    o += SIZE[e.kind] - COMMON;
  }

  for (const e of events) {
    const [code, a, b] = encodeEvent(e);
    v.setUint8(o, code);
    v.setFloat32(o + 1, e.x, LE);
    v.setFloat32(o + 5, e.y, LE);
    v.setUint16(o + 9, a & 0xffff, LE);
    v.setUint16(o + 11, b & 0xffff, LE);
    o += EVENT_SIZE;
  }
  return new Uint8Array(buf);
}

/** Validating decoder: version guard, bounds checks before every read, ranges via branded ids. */
export function decodeSnapshot(data: BinaryData): Snapshot {
  const v = view(data);
  need(v, HEADER, 'snapshot header');
  if (v.getUint8(0) !== MSG.SNAPSHOT) throw new Error('not a snapshot');
  if (v.getUint8(1) !== VERSION) throw new Error(`unsupported snapshot version ${v.getUint8(1)}`);
  const tick = asTick(v.getUint32(2, LE));
  const ack = asSeq(v.getUint32(6, LE));
  const count = v.getUint16(10, LE);
  const eventCount = v.getUint8(12);
  const entities: EntityState[] = [];
  const events: GameEvent[] = [];
  let o = HEADER;

  for (let i = 0; i < count; i++) {
    need(v, o + COMMON, 'entity header');
    const code = v.getUint8(o + 2);
    const common = {
      id: asEntityId(v.getUint16(o, LE)),
      x: v.getFloat32(o + 3, LE),
      y: v.getFloat32(o + 7, LE),
      angle: v.getInt16(o + 11, LE) / ANGLE_SCALE,
    };
    o += COMMON;
    if (code === KIND_CODE.ship) {
      need(v, o + 23, 'ship');
      const flags = v.getUint8(o + 9);
      entities.push({
        kind: 'ship',
        ...common,
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
    } else if (code === KIND_CODE.bullet) {
      need(v, o + 11, 'bullet');
      entities.push({
        kind: 'bullet',
        ...common,
        vx: v.getInt16(o, LE),
        vy: v.getInt16(o + 2, LE),
        owner: asEntityId(v.getUint16(o + 4, LE)),
        spawnSeq: asSeq(v.getUint32(o + 6, LE)),
        fast: (v.getUint8(o + 10) & 1) !== 0,
      });
      o += 11;
    } else if (code === KIND_CODE.asteroid) {
      need(v, o + 2, 'asteroid');
      const size = v.getUint8(o);
      if (!isAsteroidSize(size)) throw new RangeError(`bad asteroid size ${size}`);
      const flags = v.getUint8(o + 1);
      entities.push({
        kind: 'asteroid',
        ...common,
        size,
        seeker: (flags & 1) !== 0,
        hitFlash: (flags & 2) !== 0,
      });
      o += 2;
    } else if (code === KIND_CODE.pickup) {
      need(v, o + 2, 'pickup');
      entities.push({
        kind: 'pickup',
        ...common,
        effect: effectAt(v.getUint8(o)),
        lifeLeft: v.getUint8(o + 1) / 10,
      });
      o += 2;
    } else {
      throw new RangeError(`unknown entity kind ${code} at byte ${o - COMMON}`);
    }
  }

  for (let i = 0; i < eventCount; i++, o += EVENT_SIZE) {
    need(v, o + EVENT_SIZE, 'event');
    events.push(
      decodeEvent(
        v.getUint8(o),
        v.getFloat32(o + 1, LE),
        v.getFloat32(o + 5, LE),
        v.getUint16(o + 9, LE),
        v.getUint16(o + 11, LE),
      ),
    );
  }
  if (o !== v.byteLength) throw new RangeError(`${v.byteLength - o} trailing bytes`);
  return { tick, ack, entities, events };
}
