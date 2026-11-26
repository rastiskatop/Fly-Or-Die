// Property-based tests (fast-check): state an invariant, let the library generate thousands of
// inputs, and on failure shrink to the smallest counterexample.
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import * as binary from '../src/net/codec-binary.ts';
import * as json from '../src/net/codec-json.ts';
import { asEntityId, asSeq, asTick } from '../src/ids.ts';
import { createGame } from '../src/sim/game.ts';
import {
  DT,
  buttonsToControls,
  controlsToButtons,
  type EntityState,
  type Input,
  type Snapshot,
} from '../src/net/protocol.ts';
import { PICKUP_EFFECTS } from '../src/sim/pickup.ts';
import type { GameEvent } from '../src/sim/events.ts';
import { parseClientMessage, PROTOCOL_VERSION, ClientMessageSchema } from '../src/net/messages.ts';
import { segmentHitsCircle, circlesOverlap } from '../src/sim/collision.ts';

const BOUNDS = { width: 1280, height: 720 };

// ---------- generators: only values the protocol can represent ----------
const f32 = fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e4, max: 1e4 });
const id = fc.integer({ min: 1, max: 0xffff }).map(asEntityId);
const seq = fc.integer({ min: 1, max: 0xffffffff }).map(asSeq);
const angle = fc.double({ min: -50, max: 50, noNaN: true });
const secs = (max: number) => fc.double({ min: 0, max, noNaN: true });
const common = { id, x: f32, y: f32, angle };

const ship = fc.record({
  kind: fc.constant('ship' as const),
  ...common,
  vx: f32,
  vy: f32,
  hp: fc.integer({ min: 0, max: 100 }),
  score: fc.integer({ min: 0, max: 0xffff }),
  deaths: fc.integer({ min: 0, max: 0xffff }),
  destroyed: fc.boolean(),
  thrusting: fc.boolean(),
  hitFlash: fc.boolean(),
  speed: secs(60),
  bullets: secs(60),
  invulnerable: secs(60),
  respawnIn: secs(60),
  fireCooldown: secs(0.25),
});
const bullet = fc.record({
  kind: fc.constant('bullet' as const),
  ...common,
  vx: fc.integer({ min: -32768, max: 32767 }),
  vy: fc.integer({ min: -32768, max: 32767 }),
  owner: id,
  spawnSeq: seq,
  fast: fc.boolean(),
});
const asteroid = fc.record({
  kind: fc.constant('asteroid' as const),
  ...common,
  size: fc.constantFrom(1 as const, 2 as const, 3 as const),
  seeker: fc.boolean(),
  hitFlash: fc.boolean(),
});
const pickup = fc.record({
  kind: fc.constant('pickup' as const),
  ...common,
  effect: fc.constantFrom(...PICKUP_EFFECTS),
  lifeLeft: secs(25),
});
const entity: fc.Arbitrary<EntityState> = fc.oneof(ship, bullet, asteroid, pickup);

const at = { x: f32, y: f32 };
const event: fc.Arbitrary<GameEvent> = fc.oneof(
  fc.record({ type: fc.constant('fired' as const), ...at, shipId: id, fast: fc.boolean() }),
  fc.record({
    type: fc.constant('hit' as const),
    ...at,
    kind: fc.constant('ship' as const),
    id,
    damage: fc.integer({ min: 0, max: 0xffff }),
  }),
  fc.record({
    type: fc.constant('hit' as const),
    ...at,
    kind: fc.constant('asteroid' as const),
    id,
  }),
  fc.record({
    type: fc.constant('exploded' as const),
    ...at,
    kind: fc.constant('ship' as const),
    shipId: id,
  }),
  fc.record({
    type: fc.constant('exploded' as const),
    ...at,
    kind: fc.constant('asteroid' as const),
    size: fc.constantFrom(1 as const, 2 as const, 3 as const),
  }),
  fc.record({
    type: fc.constant('scored' as const),
    ...at,
    shipId: id,
    points: fc.integer({ min: 0, max: 0xffff }),
  }),
  fc.record({
    type: fc.constant('pickup' as const),
    ...at,
    shipId: id,
    effect: fc.constantFrom(...PICKUP_EFFECTS),
  }),
  fc.record({ type: fc.constant('respawned' as const), ...at, shipId: id }),
);

const snapshot: fc.Arbitrary<Snapshot> = fc.record({
  tick: fc.integer({ min: 0, max: 0xffffffff }).map(asTick),
  ack: fc.integer({ min: 0, max: 0xffffffff }).map(asSeq),
  entities: fc.array(entity, { maxLength: 40 }),
  events: fc.array(event, { maxLength: 20 }),
});

const input: fc.Arbitrary<Input> = fc.record({ seq, buttons: fc.integer({ min: 0, max: 15 }) });

const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('binary codec properties', () => {
  test('round-trip: decode(encode(s)) ≈ s within the quantization the spec allows', () => {
    fc.assert(
      fc.property(snapshot, (snap) => {
        const back = binary.decodeSnapshot(binary.encodeSnapshot(snap));
        expect(back.tick).toBe(snap.tick);
        expect(back.ack).toBe(snap.ack);
        expect(back.entities).toHaveLength(snap.entities.length);
        snap.entities.forEach((a, i) => {
          const b = back.entities[i];
          if (!b) throw new Error('missing entity');
          expect(b.kind).toBe(a.kind);
          expect(b.id).toBe(a.id);
          expect(b.x).toBe(Math.fround(a.x)); // f32: exactly the nearest float32
          expect(b.y).toBe(Math.fround(a.y));
          expect(angleDiff(b.angle, a.angle)).toBeLessThanOrEqual(0.5e-4 + 1e-9);
          if (a.kind === 'ship' && b.kind === 'ship') {
            expect([b.hp, b.score, b.deaths, b.destroyed, b.thrusting, b.hitFlash]).toEqual([
              a.hp,
              a.score,
              a.deaths,
              a.destroyed,
              a.thrusting,
              a.hitFlash,
            ]);
            expect(Math.abs(b.speed - a.speed)).toBeLessThanOrEqual(0.0005 + 1e-12);
            expect(Math.abs(b.fireCooldown - a.fireCooldown)).toBeLessThanOrEqual(0.0005 + 1e-12);
          }
          if (a.kind === 'bullet' && b.kind === 'bullet') {
            expect([b.vx, b.vy, b.owner, b.spawnSeq, b.fast]).toEqual([
              a.vx,
              a.vy,
              a.owner,
              a.spawnSeq,
              a.fast,
            ]);
          }
          if (a.kind === 'asteroid' && b.kind === 'asteroid')
            expect([b.size, b.seeker, b.hitFlash]).toEqual([a.size, a.seeker, a.hitFlash]);
          if (a.kind === 'pickup' && b.kind === 'pickup') {
            expect(b.effect).toBe(a.effect);
            expect(Math.abs(b.lifeLeft - a.lifeLeft)).toBeLessThanOrEqual(0.05 + 1e-12);
          }
        });
        expect(back.events.map((e) => e.type)).toEqual(snap.events.map((e) => e.type));
      }),
      { numRuns: 300 },
    );
  });

  test('length: encoded size = 13 + Σ entity sizes (36/24/15/15) + 13 per event', () => {
    const SIZE = { ship: 36, bullet: 24, asteroid: 15, pickup: 15 } as const;
    fc.assert(
      fc.property(snapshot, (snap) => {
        const expected =
          13 + snap.entities.reduce((n, e) => n + SIZE[e.kind], 0) + 13 * snap.events.length;
        expect(binary.encodeSnapshot(snap).byteLength).toBe(expected);
        expect(binary.snapshotSize(snap)).toBe(expected);
      }),
    );
  });

  test('inputs: round-trip exact, frame is 2 + 5n bytes', () => {
    fc.assert(
      fc.property(fc.array(input, { minLength: 1, maxLength: 8 }), (inputs) => {
        const frame = binary.encodeInputs(inputs);
        expect(frame.byteLength).toBe(2 + 5 * inputs.length);
        expect(binary.decodeInputs(frame)).toEqual(inputs);
      }),
    );
  });

  test('garbage safety: random bytes never crash the decoders — a clean Error or a valid message', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        for (const decode of [binary.decodeSnapshot, binary.decodeInputs]) {
          try {
            decode(bytes);
          } catch (err) {
            expect(err).toBeInstanceOf(Error); // RangeError / ZodError / Error — never a TypeError
            expect(err).not.toBeInstanceOf(TypeError);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });

  test('garbage safety: a valid snapshot with ONE corrupted byte or truncated still fails cleanly', () => {
    fc.assert(
      fc.property(
        snapshot,
        fc.nat(),
        fc.integer({ min: 0, max: 255 }),
        fc.boolean(),
        (snap, pos, value, cut) => {
          const bytes = binary.encodeSnapshot(snap).slice();
          const i = pos % bytes.length;
          if (cut) {
            const short = bytes.slice(0, i);
            expect(() => binary.decodeSnapshot(short)).toThrow(Error);
            return;
          }
          bytes[i] = value;
          try {
            binary.decodeSnapshot(bytes);
          } catch (err) {
            expect(err).not.toBeInstanceOf(TypeError);
          }
        },
      ),
    );
  });

  test('pooled decode ≡ fresh decode, even when the pool holds stale objects from other snapshots', () => {
    const pool = new binary.SnapshotPool();
    fc.assert(
      fc.property(snapshot, snapshot, (old, snap) => {
        pool.release(binary.decodeSnapshot(binary.encodeSnapshot(old), pool).entities); // dirty the pool
        const frame = binary.encodeSnapshot(snap);
        expect(binary.decodeSnapshot(frame, pool)).toEqual(binary.decodeSnapshot(frame));
      }),
      { numRuns: 200 },
    );
    expect(pool.reused).toBeGreaterThan(0);
  });

  test('JSON codec: exact round-trip', () => {
    fc.assert(
      fc.property(snapshot, (snap) => {
        const clean = { ...snap, entities: snap.entities.map((e) => ({ ...e })) };
        expect(json.decodeSnapshot(json.encodeSnapshot(clean))).toEqual(
          JSON.parse(JSON.stringify(clean)),
        );
      }),
      { numRuns: 100 },
    );
  });
});

describe('protocol parser properties', () => {
  // Names and chat: printable characters only (the schema rejects control/format characters).
  const printable = (max: number) =>
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: max }).filter((s) => {
      const t = s.trim();
      return t.length > 0 && t.length <= max && /^[^\p{Cc}\p{Cf}]+$/u.test(t);
    });
  const name = printable(16);
  const validMessage = fc.oneof(
    fc.record({
      type: fc.constant('join'),
      room: fc.stringMatching(/^[a-z0-9-]{1,32}$/),
      name,
      codec: fc.constantFrom('json', 'binary'),
    }),
    fc.record({ type: fc.constant('chat'), text: printable(200) }),
    fc.record({ type: fc.constant('leave') }),
    fc.record({ type: fc.constant('ping'), t: fc.double({ min: 0, max: 1e12, noNaN: true }) }),
    fc.record({
      type: fc.constant('netsim'),
      lagMs: fc.integer({ min: 0, max: 1000 }),
      jitterMs: fc.integer({ min: 0, max: 500 }),
      dropPct: fc.integer({ min: 0, max: 50 }),
    }),
    fc.record({
      type: fc.constant('inputs'),
      inputs: fc.array(
        fc.tuple(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 15 })),
        { minLength: 1, maxLength: 8 },
      ),
    }),
  );

  test('accepts every generated valid message', () => {
    fc.assert(
      fc.property(validMessage, (msg) => {
        const res = parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
        expect(res.ok).toBe(true);
      }),
    );
  });

  test('rejects every mutation: wrong version, unknown type, a field removed or replaced by garbage', () => {
    const garbage = fc.oneof(
      fc.constant(null),
      fc.string(),
      fc.double(),
      fc.boolean(),
      fc.object(),
      fc.constant(-1),
      fc.constant(1e12),
    );
    fc.assert(
      fc.property(
        validMessage,
        fc.nat(),
        garbage,
        fc.constantFrom('version', 'type', 'drop', 'replace'),
        (msg, k, junk, how) => {
          const m: Record<string, unknown> = { v: PROTOCOL_VERSION, ...msg };
          const fields = Object.keys(msg).filter((f) => f !== 'type');
          const field = fields[k % Math.max(1, fields.length)];
          if (how === 'version') m.v = PROTOCOL_VERSION + 1;
          else if (how === 'type') m.type = 'teleport';
          else if (!field)
            return; // 'leave' has no fields to mutate
          else if (how === 'drop') delete m[field];
          else m[field] = junk;
          // A replacement that happens to be valid isn't a mutation (e.g. a random but legal string).
          if (ClientMessageSchema.safeParse(m).success) return;
          expect(parseClientMessage(JSON.stringify(m)).ok).toBe(false);
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('never throws, whatever text arrives', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        expect(() => parseClientMessage(text)).not.toThrow();
      }),
    );
  });
});

describe('simulation properties', () => {
  test('ships stay inside the arena over 1,000 random input steps', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 1000, maxLength: 1000 }),
        (buttons) => {
          const { world, player } = createGame({ ...BOUNDS });
          for (const b of buttons) {
            world.step(DT, new Map([[player.id, buttonsToControls(b)]]));
            for (const s of world.ofKind('ship')) {
              expect(s.pos.x).toBeGreaterThanOrEqual(0);
              expect(s.pos.x).toBeLessThan(BOUNDS.width);
              expect(s.pos.y).toBeGreaterThanOrEqual(0);
              expect(s.pos.y).toBeLessThan(BOUNDS.height);
              expect(s.vel.length()).toBeLessThanOrEqual(1200 + 1e-6);
            }
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  test('determinism: the same random input sequence twice → identical worlds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 50, maxLength: 200 }),
        (buttons) => {
          const run = () => {
            const { world, player } = createGame({ ...BOUNDS });
            for (const b of buttons) world.step(DT, new Map([[player.id, buttonsToControls(b)]]));
            return [...world].map((e) => [e.kind, e.pos.x, e.pos.y, e.vel.x, e.vel.y]);
          };
          expect(run()).toEqual(run());
        },
      ),
      { numRuns: 20 },
    );
  });

  test('buttons ↔ controls is a bijection on 0..15', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        (b) => controlsToButtons(buttonsToControls(b)) === b,
      ),
    );
  });

  test('swept collision is never weaker than the point test at the segment end', () => {
    const p = fc.record({
      x: fc.double({ min: 0, max: 1280, noNaN: true }),
      y: fc.double({ min: 0, max: 720, noNaN: true }),
    });
    fc.assert(
      fc.property(p, p, p, fc.double({ min: 1, max: 60, noNaN: true }), (from, to, c, r) => {
        if (
          circlesOverlap({ pos: to, radius: r }, { pos: c, radius: 0 }) &&
          Math.abs(to.x - from.x) <= 640 &&
          Math.abs(to.y - from.y) <= 360
        ) {
          expect(segmentHitsCircle(from, to, c, r, BOUNDS)).toBe(true);
        }
      }),
    );
  });
});

test('fast-check sanity (the notes experiment): every float32 is its own fround, doubles are not', () => {
  fc.assert(fc.property(fc.float({ noNaN: true }), (x) => Object.is(Math.fround(x), x)));
  const res = fc.check(
    fc.property(fc.double({ noNaN: true }), (x) => Object.is(Math.fround(x), x)),
  );
  expect(res.failed).toBe(true); // shrunk to a small double that float32 can't hold, e.g. 1e-45-ish or 0.1
});
