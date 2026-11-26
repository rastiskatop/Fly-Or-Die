import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as binary from '../src/net/codec-binary.ts';
import * as json from '../src/net/codec-json.ts';
import {
  snapshotEntities,
  collectEvents,
  DT,
  controlsToButtons,
  buttonsToControls,
  type EntityState,
  type Snapshot,
} from '../src/net/protocol.ts';
import { parseClientMessage, CLOSE } from '../src/net/messages.ts';
import { createMatchWorld, spawnPlayerShip } from '../src/sim/game.ts';
import { simulationHash } from '../src/sim/determinism.ts';
import { stepShipMotion, physics, type ShipMotionState, type ShipEffect } from '../src/sim/ship.ts';
import { Vector2 } from '../src/sim/vector.ts';
import { dsin, dcos, datan2 } from '../src/sim/dmath.ts';
import { asSeq, asTick } from '../src/ids.ts';

test('the shared sim imports in Node with no DOM', () => {
  assert.equal('document' in globalThis, false);
  assert.equal('window' in globalThis, false);
  const world = createMatchWorld({ width: 1280, height: 720 });
  assert.ok(world.size > 0);
});

test('determinism: same inputs → same hash, every run', () => {
  const a = simulationHash(600);
  const b = simulationHash(600);
  assert.deepEqual(a, b);
  console.log('    simulation hash after 600 steps:', a);
});

test('determinism across engines: the golden hash (browser and Node must print the same)', () => {
  // Before dmath.ts (Math.sin/cos/atan2 in the sim) Node gave 99fcd6d2 and Chrome 2fc52ad4.
  // With bit-exact trigonometry both gave b736f092, unchanged by the Lab 6 TypeScript rewrite.
  // Lab 7 changed it ON PURPOSE, once: swept bullet collisions — in this 600-step run some
  // bullets used to tunnel through rocks and now hit them. The spatial hash and the object
  // pools that came after must NOT change it again.
  assert.equal(simulationHash(600).hash, '46a323ea');
});

test('dmath: within 1 ulp-ish of Math, bit-identical everywhere', () => {
  for (let i = 0; i < 20000; i++) {
    const x = (i / 20000 - 0.5) * 40;
    assert.ok(Math.abs(dsin(x) - Math.sin(x)) < 3e-16);
    assert.ok(Math.abs(dcos(x) - Math.cos(x)) < 3e-16);
    const y = Math.sin(i) * 300;
    const z = Math.cos(i * 0.7) * 300;
    assert.ok(Math.abs(datan2(y, z) - Math.atan2(y, z)) < 1e-15);
  }
});

test('determinism: Math.random() in motion breaks it (the experiment)', () => {
  const run = () => {
    const s: ShipMotionState = {
      pos: new Vector2(100, 100),
      vel: Vector2.ZERO,
      angle: 0,
      effects: new Map<ShipEffect, number>(),
      invulnerableFor: 0,
      fireCooldown: 0,
      thrusting: false,
    };
    for (let i = 0; i < 100; i++) {
      stepShipMotion(s, { thrust: true, left: i % 3 === 0, right: false, fire: false }, DT, {
        width: 1280,
        height: 720,
      });
    }
    return [s.pos.x, s.pos.y];
  };
  assert.deepEqual(run(), run());
  physics.chaos = true;
  const x = run();
  const y = run();
  physics.chaos = false;
  assert.notDeepEqual(x, y);
});

test('buttons ↔ controls', () => {
  for (let b = 0; b < 16; b++) assert.equal(controlsToButtons(buttonsToControls(b)), b);
});

function liveSnapshot(): Snapshot {
  const world = createMatchWorld({ width: 1280, height: 720 });
  const events = collectEvents(world);
  const ships = [0, 1, 2, 3].map((i) => spawnPlayerShip(world, `P${i}`));
  for (let i = 0; i < 90; i++) {
    for (const s of ships) s.inputSeq = asSeq(i + 1);
    world.step(
      DT,
      new Map(ships.map((s, k) => [s.id, buttonsToControls((i + k) % 3 === 0 ? 12 : 5)])),
    );
  }
  ships[0]?.effects.set('speed', 4.25);
  return {
    tick: asTick(world.tick),
    ack: asSeq(1234567),
    entities: snapshotEntities(world),
    events: events.slice(-20),
  };
}

/** Pairs up original and decoded entities, failing if the decoder changed the kind. */
function pairs(a: readonly EntityState[], b: readonly EntityState[]): [EntityState, EntityState][] {
  assert.equal(b.length, a.length);
  return a.map((x, i) => {
    const y = b[i];
    assert.ok(y && y.kind === x.kind && y.id === x.id);
    return [x, y];
  });
}

test('binary codec: decode(encode(snapshot)) ≈ snapshot within quantization', () => {
  const snap = liveSnapshot();
  const back = binary.decodeSnapshot(binary.encodeSnapshot(snap));
  assert.equal(back.tick, snap.tick);
  assert.equal(back.ack, snap.ack);
  for (const [a, b] of pairs(snap.entities, back.entities)) {
    assert.ok(Math.abs(b.x - a.x) < 1e-3, 'x within float32');
    assert.ok(Math.abs(b.y - a.y) < 1e-3, 'y within float32');
    const da = Math.abs(Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle)));
    assert.ok(da <= 0.5e-4 + 1e-9, `angle within 1/20000 rad (${a.kind} ${a.angle} → ${b.angle})`);
    if (a.kind === 'ship' && b.kind === 'ship') {
      assert.ok(Math.abs(b.vx - a.vx) < 1e-3);
      assert.equal(b.hp, a.hp);
      assert.equal(b.destroyed, a.destroyed);
      assert.ok(Math.abs(b.speed - a.speed) <= 0.0005);
    } else if (a.kind === 'bullet' && b.kind === 'bullet') {
      assert.ok(Math.abs(b.vx - a.vx) <= 0.5);
      assert.equal(b.owner, a.owner);
      assert.equal(b.spawnSeq, a.spawnSeq);
      assert.equal(b.fast, a.fast);
    } else if (a.kind === 'asteroid' && b.kind === 'asteroid') {
      assert.equal(b.size, a.size);
    } else if (a.kind === 'pickup' && b.kind === 'pickup') {
      assert.equal(b.effect, a.effect);
    }
  }
  assert.deepEqual(
    back.events.map((e) => e.type),
    snap.events.map((e) => e.type),
  );
});

test('binary codec: input round-trip and rejection of garbage', () => {
  const inputs = [
    { seq: asSeq(1), buttons: 0 },
    { seq: asSeq(2), buttons: 15 },
    { seq: asSeq(0xfffffffe), buttons: 9 },
  ];
  assert.deepEqual(binary.decodeInputs(binary.encodeInputs(inputs)), inputs);
  assert.throws(() => binary.decodeInputs(new Uint8Array([2, 1, 0, 0, 0, 0, 0])));
  assert.throws(() => binary.decodeInputs(new Uint8Array([1, 3, 1, 2])));
  assert.throws(() => binary.decodeInputs(new Uint8Array([1, 1, 1, 0, 0, 0, 99])), 'buttons > 15');
});

test('binary snapshot decoder validates: truncation, version, kinds, trailing bytes', () => {
  const bytes = binary.encodeSnapshot(liveSnapshot());
  assert.throws(() => binary.decodeSnapshot(bytes.subarray(0, bytes.length - 3)), /truncated/);
  const badVersion = bytes.slice();
  badVersion[1] = 9;
  assert.throws(() => binary.decodeSnapshot(badVersion), /version/);
  const badKind = bytes.slice();
  badKind[13 + 2] = 77;
  assert.throws(() => binary.decodeSnapshot(badKind), /unknown entity kind/);
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assert.throws(() => binary.decodeSnapshot(longer), /trailing/);
});

test('binary decoding respects Buffer byteOffset (Node gives views into a shared pool)', () => {
  const bytes = binary.encodeInputs([{ seq: asSeq(42), buttons: 5 }]);
  const pool = new Uint8Array(64);
  pool.set(bytes, 17);
  assert.deepEqual(binary.decodeInputs(pool.subarray(17, 17 + bytes.length)), [
    { seq: 42, buttons: 5 },
  ]);
});

test('json codec round-trip (validated by the zod schemas)', () => {
  const snap = liveSnapshot();
  assert.deepEqual(
    json.decodeSnapshot(json.encodeSnapshot(snap)),
    JSON.parse(JSON.stringify(snap)),
  );
  assert.deepEqual(json.decodeInputs(json.encodeInputs([{ seq: asSeq(3), buttons: 4 }])), [
    { seq: 3, buttons: 4 },
  ]);
  assert.throws(() =>
    json.decodeSnapshot(
      JSON.stringify({ v: 1, type: 'snapshot', tick: -1, ack: 0, entities: [], events: [] }),
    ),
  );
});

test('parseClientMessage: typed result, never throws', () => {
  const ok = parseClientMessage(
    JSON.stringify({ v: 1, type: 'join', room: 'eu-1', name: '  Ace  ' }),
  );
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, { v: 1, type: 'join', room: 'eu-1', name: 'Ace', codec: 'json' });
  const cases: [unknown, number][] = [
    ['{oops', CLOSE.BAD_MESSAGE],
    [[1, 2], CLOSE.BAD_MESSAGE],
    [{ v: 2, type: 'chat', text: 'x' }, CLOSE.BAD_VERSION],
    [{ v: 1, type: 'hack' }, CLOSE.UNKNOWN_TYPE],
    [{ v: 1, type: '__proto__' }, CLOSE.UNKNOWN_TYPE],
    [{ v: 1, type: 'chat', text: 'x'.repeat(201) }, CLOSE.BAD_MESSAGE],
    [{ v: 1, type: 'chat', text: 'a\nb' }, CLOSE.BAD_MESSAGE],
    [{ v: 1, type: 'join', room: '../etc', name: 'x' }, CLOSE.BAD_MESSAGE],
    [{ v: 1, type: 'netsim', lagMs: 1e9, jitterMs: 0, dropPct: 0 }, CLOSE.BAD_MESSAGE],
  ];
  for (const [input, code] of cases) {
    const r = parseClientMessage(typeof input === 'string' ? input : JSON.stringify(input));
    assert.equal(r.ok, false, JSON.stringify(input));
    if (!r.ok) assert.equal(r.error.code, code, JSON.stringify(input));
  }
});

test('binary is much smaller than JSON', () => {
  const snap = liveSnapshot();
  const b = binary.encodeSnapshot(snap).byteLength;
  const j = new TextEncoder().encode(json.encodeSnapshot(snap)).byteLength;
  console.log(
    `    snapshot with ${snap.entities.length} entities: binary ${b} B, JSON ${j} B (${(j / b).toFixed(1)}×)`,
  );
  assert.ok(b * 3 < j);
});
