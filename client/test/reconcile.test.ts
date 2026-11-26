// Reconciliation as a pure function: (server state, input buffer, ack) → (replayed state, pending, correction).
import { describe, expect, test } from 'vitest';
import { reconcile, wrappedDelta } from '../src/net/reconcile.ts';
import { Vector2 } from '@flyordie/shared/sim/vector.ts';
import { stepShipMotion, type ShipMotionState } from '@flyordie/shared/sim/ship.ts';
import { BUTTON, DT, buttonsToControls, type Input } from '@flyordie/shared/net/protocol.ts';
import { asSeq } from '@flyordie/shared/ids.ts';

const BOUNDS = { width: 1280, height: 720 };
const state = (x = 640, y = 360): ShipMotionState => ({
  pos: new Vector2(x, y),
  vel: Vector2.ZERO,
  angle: 0,
  effects: new Map(),
  invulnerableFor: 0,
  fireCooldown: 0,
  thrusting: false,
});
const inputs = (from: number, to: number, buttons: number): Input[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ seq: asSeq(from + i), buttons }));

describe('reconcile', () => {
  test('perfect prediction → correction 0, acked inputs dropped', () => {
    // The client predicted inputs 1..10 from (640,360). The server applied 1..6.
    const all = inputs(1, 10, BUTTON.thrust);
    const predicted = state();
    for (const i of all) stepShipMotion(predicted, buttonsToControls(i.buttons), DT, BOUNDS);
    const server = state();
    for (const i of all.slice(0, 6))
      stepShipMotion(server, buttonsToControls(i.buttons), DT, BOUNDS);

    const r = reconcile(server, predicted.pos, all, asSeq(6), BOUNDS, true);
    expect(r.pending.map((i) => i.seq)).toEqual([7, 8, 9, 10]);
    expect(r.correction).toBe(0); // same deterministic steps → bit-identical
    expect(server.pos).toEqual(predicted.pos);
  });

  test('the server disagrees (we were pushed) → the correction is exactly the push', () => {
    const all = inputs(1, 4, 0);
    const pushed = state(700, 360); // a collision on the server moved us 60 px
    const r = reconcile(pushed, new Vector2(640, 360), all, asSeq(4), BOUNDS, true);
    expect(r.pending).toEqual([]);
    expect(r.dx).toBe(-60);
    expect(r.dy).toBe(0);
    expect(r.correction).toBe(60);
  });

  test('replay off (prediction disabled / destroyed) → server state taken as is', () => {
    const all = inputs(1, 5, BUTTON.thrust);
    const server = state();
    const r = reconcile(server, new Vector2(600, 360), all, asSeq(2), BOUNDS, false);
    expect(server.pos).toEqual(new Vector2(640, 360));
    expect(r.pending.map((i) => i.seq)).toEqual([3, 4, 5]);
  });

  test('a replayed fire input restarts the cooldown', () => {
    const server = state();
    reconcile(server, server.pos, inputs(1, 1, BUTTON.fire), asSeq(0), BOUNDS, true);
    expect(server.fireCooldown).toBeGreaterThan(0);
  });

  test('corrections are measured through the wrap: 1279 → 1 is 2 px, not 1278', () => {
    expect(wrappedDelta({ x: 1279, y: 10 }, { x: 1, y: 10 }, BOUNDS)).toEqual({ dx: -2, dy: 0 });
    expect(wrappedDelta({ x: 5, y: 719 }, { x: 5, y: 1 }, BOUNDS)).toEqual({ dx: 0, dy: -2 });
  });
});
