// A tiny "pilot" used by headless test clients (server/scripts) and the client's ?autopilot=1:
// turn toward the nearest target, thrust when far, fire when lined up. Pure function of the
// state it's given, so it's deterministic for a given picture of the world.
import { BUTTON } from './net/protocol.js';

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * @param me       { x, y, angle } — our ship
 * @param targets  [{ x, y }] — things worth shooting
 * @param t        a step counter, for a bit of variety
 * @returns buttons bitmask (see BUTTON)
 */
export function botButtons(me, targets, t = 0) {
  if (!me) return 0;
  let best = null;
  let bestD = Infinity;
  for (const p of targets) {
    const d = (p.x - me.x) ** 2 + (p.y - me.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  let buttons = 0;
  if (!best) return t % 60 < 30 ? BUTTON.thrust | BUTTON.left : BUTTON.thrust;
  const diff = wrapAngle(Math.atan2(best.y - me.y, best.x - me.x) - me.angle);
  if (diff > 0.08) buttons |= BUTTON.right;
  else if (diff < -0.08) buttons |= BUTTON.left;
  const dist = Math.sqrt(bestD);
  if (dist > 220 || t % 45 < 8) buttons |= BUTTON.thrust;
  if (Math.abs(diff) < 0.25 && dist < 600) buttons |= BUTTON.fire;
  return buttons;
}
