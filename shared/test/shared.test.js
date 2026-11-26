import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as binary from '../src/net/codec-binary.js';
import * as json from '../src/net/codec-json.js';
import {
  snapshotEntities,
  collectEvents,
  DT,
  controlsToButtons,
  buttonsToControls,
} from '../src/net/protocol.js';
import { createMatchWorld, spawnPlayerShip } from '../src/sim/game.js';
import { simulationHash } from '../src/sim/determinism.js';
import { stepShipMotion, physics } from '../src/sim/ship.js';
import { Vector2 } from '../src/sim/vector.js';

test('the shared sim imports in Node with no DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
  const world = createMatchWorld({ width: 1280, height: 720 });
  assert.ok(world.size > 0);
});

test('determinism: same inputs → same hash, every run', () => {
  const a = simulationHash(600);
  const b = simulationHash(600);
  assert.deepEqual(a, b);
  console.log('    simulation hash after 600 steps:', a);
});

test('determinism across engines: the hash Chrome 156 computed for the same run', () => {
  // Before dmath.js (Math.sin/cos/atan2 in the sim) Node gave 99fcd6d2 and Chrome 2fc52ad4.
  // With bit-exact trigonometry both give b736f092 — check the browser with ?demo=determinism.
  assert.equal(simulationHash(600).hash, 'b736f092');
});

test('dmath: within 1 ulp-ish of Math, bit-identical everywhere', async () => {
  const { dsin, dcos, datan2 } = await import('../src/sim/dmath.js');
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
    const s = {
      pos: new Vector2(100, 100),
      vel: new Vector2(0, 0),
      angle: 0,
      effects: new Map(),
      invulnerableFor: 0,
      fireCooldown: 0,
      thrusting: false,
    };
    for (let i = 0; i < 100; i++)
      stepShipMotion(s, { thrust: true, left: i % 3 === 0 }, DT, { width: 1280, height: 720 });
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

function liveSnapshot() {
  const world = createMatchWorld({ width: 1280, height: 720 });
  const events = collectEvents(world);
  const ships = [0, 1, 2, 3].map((i) => spawnPlayerShip(world, `P${i}`));
  for (let i = 0; i < 90; i++) {
    for (const s of ships) s.inputSeq = i + 1;
    world.step(
      DT,
      new Map(ships.map((s, k) => [s.id, buttonsToControls((i + k) % 3 === 0 ? 12 : 5)])),
    );
  }
  ships[0].effects.set('speed', 4.25);
  return {
    tick: world.tick,
    ack: 1234567,
    entities: snapshotEntities(world),
    events: events.slice(-20),
  };
}

test('binary codec: decode(encode(snapshot)) ≈ snapshot within quantization', () => {
  const snap = liveSnapshot();
  const back = binary.decodeSnapshot(binary.encodeSnapshot(snap));
  assert.equal(back.tick, snap.tick);
  assert.equal(back.ack, snap.ack);
  assert.equal(back.entities.length, snap.entities.length);
  for (let i = 0; i < snap.entities.length; i++) {
    const a = snap.entities[i];
    const b = back.entities[i];
    assert.equal(b.id, a.id);
    assert.equal(b.kind, a.kind);
    assert.ok(Math.abs(b.x - a.x) < 1e-3, 'x within float32');
    assert.ok(Math.abs(b.y - a.y) < 1e-3, 'y within float32');
    const da = Math.abs(Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle)));
    assert.ok(da <= 0.5e-4 + 1e-9, `angle within 1/20000 rad (${a.kind} ${a.angle} → ${b.angle})`);
    if (a.kind === 'ship') {
      assert.ok(Math.abs(b.vx - a.vx) < 1e-3);
      assert.equal(b.hp, a.hp);
      assert.equal(b.destroyed, a.destroyed);
      assert.ok(Math.abs(b.speed - a.speed) <= 0.0005);
    }
    if (a.kind === 'bullet') {
      assert.ok(Math.abs(b.vx - a.vx) <= 0.5);
      assert.equal(b.owner, a.owner);
      assert.equal(b.spawnSeq, a.spawnSeq);
      assert.equal(b.fast, a.fast);
    }
    if (a.kind === 'asteroid') assert.equal(b.size, a.size);
    if (a.kind === 'pickup') assert.equal(b.effect, a.effect);
  }
  assert.equal(back.events.length, snap.events.length);
  for (let i = 0; i < snap.events.length; i++)
    assert.equal(back.events[i].type, snap.events[i].type);
});

test('binary codec: input round-trip and rejection of garbage', () => {
  const inputs = [
    { seq: 1, buttons: 0 },
    { seq: 2, buttons: 15 },
    { seq: 0xfffffffe, buttons: 9 },
  ];
  assert.deepEqual(binary.decodeInputs(binary.encodeInputs(inputs)), inputs);
  assert.throws(() => binary.decodeInputs(new Uint8Array([2, 1, 0, 0, 0, 0, 0])));
  assert.throws(() => binary.decodeInputs(new Uint8Array([1, 3, 1, 2])));
});

test('binary decoding respects Buffer byteOffset (Node gives views into a shared pool)', () => {
  const bytes = binary.encodeInputs([{ seq: 42, buttons: 5 }]);
  const pool = new Uint8Array(64);
  pool.set(bytes, 17);
  assert.deepEqual(binary.decodeInputs(pool.subarray(17, 17 + bytes.length)), [
    { seq: 42, buttons: 5 },
  ]);
});

test('json codec round-trip', () => {
  const snap = liveSnapshot();
  assert.deepEqual(
    json.decodeSnapshot(json.encodeSnapshot(snap)),
    JSON.parse(JSON.stringify(snap)),
  );
  assert.deepEqual(json.decodeInputs(json.encodeInputs([{ seq: 3, buttons: 4 }])), [
    { seq: 3, buttons: 4 },
  ]);
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
