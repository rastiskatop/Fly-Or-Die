// Client-side reconciliation as a pure step, so it can be unit-tested without sockets or a DOM.
//
//   predicted ──(snapshot arrives)──▶ reset to the server's state for tick T (acked input seq A)
//             ──▶ drop inputs ≤ A ──▶ replay the inputs the server hasn't seen yet
//             ──▶ correction = |predicted − replayed|, measured through the arena wrap
import { DT, buttonsToControls, type Input } from '@flyordie/shared/net/protocol.ts';
import {
  stepShipMotion,
  FIRE_COOLDOWN_S,
  type Bounds,
  type ShipMotionState,
} from '@flyordie/shared/sim/ship.ts';
import type { Seq } from '@flyordie/shared/ids.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Reconciled {
  /** Inputs the server has not acknowledged yet (to resend and to replay next time). */
  readonly pending: Input[];
  /** Shortest offset from the corrected position back to where we had predicted ourselves. */
  readonly dx: number;
  readonly dy: number;
  /** |(dx, dy)| in px — 0 means the prediction was exact. */
  readonly correction: number;
}

/** a − b on a torus of size `bounds`: the shortest way round, so a wrap isn't a 1280-px error. */
export function wrappedDelta(a: Point, b: Point, bounds: Bounds): { dx: number; dy: number } {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  dx -= Math.round(dx / bounds.width) * bounds.width;
  dy -= Math.round(dy / bounds.height) * bounds.height;
  return { dx, dy };
}

/**
 * @param ship      already reset to the server's authoritative state; replay mutates it in place
 *                  (the caller owns it — the shared stepShipMotion works on mutable state)
 * @param predicted where the client had drawn itself before the snapshot arrived
 * @param pending   inputs sent but not yet known to be applied
 * @param ack       the last input seq the server applied for this client
 * @param replay    false = prediction off / ship destroyed: take the server state as is
 */
export function reconcile(
  ship: ShipMotionState,
  predicted: Point,
  pending: readonly Input[],
  ack: Seq,
  bounds: Bounds,
  replay: boolean,
): Reconciled {
  const unacked = pending.filter((i) => i.seq > ack);
  if (replay) {
    for (const input of unacked) {
      if (stepShipMotion(ship, buttonsToControls(input.buttons), DT, bounds))
        ship.fireCooldown = FIRE_COOLDOWN_S;
    }
  }
  const { dx, dy } = wrappedDelta(predicted, ship.pos, bounds);
  return { pending: unacked, dx, dy, correction: Math.hypot(dx, dy) };
}
