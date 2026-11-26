// Collision detection as a standalone system that only *reports* pairs, so the broad phase can be
// swapped (naive O(n²) → spatial hash) without touching the code that decides what a hit means.
//
// Narrow phase: circles overlap at the end of the step — plus, for bullets, a SWEPT test along
// the segment they travelled this step. A fast bullet at the 30 Hz server tick moves ~67 px per
// step, more than the smallest rock is wide (34 px with the bullet), so a point test lets it
// tunnel straight through (Lab 7 test "a fast bullet does not tunnel…"). Only + − × ÷ here:
// the result must be bit-identical in the browser and in Node (Lab 5 determinism).
import type { AnyEntity, World } from './world.ts';

export type CollisionPair = readonly [AnyEntity, AnyEntity];
export type CollisionSystem = (world: World) => CollisionPair[];

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Circle {
  readonly pos: Point;
  readonly radius: number;
}

export function circlesOverlap(a: Circle, b: Circle): boolean {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const r = a.radius + b.radius;
  return dx * dx + dy * dy < r * r;
}

/**
 * Does the segment from → to pass within `r` of `c`? (closest point on the segment to the centre)
 * A segment longer than half the arena means the mover wrapped around an edge this step — that
 * is not a path it really flew, so it doesn't count.
 */
export function segmentHitsCircle(
  from: Point,
  to: Point,
  c: Point,
  r: number,
  bounds: { width: number; height: number },
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (
    dx > bounds.width / 2 ||
    -dx > bounds.width / 2 ||
    dy > bounds.height / 2 ||
    -dy > bounds.height / 2
  )
    return false;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((c.x - from.x) * dx + (c.y - from.y) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = from.x + dx * t - c.x;
  const py = from.y + dy * t - c.y;
  return px * px + py * py < r * r;
}

/** The narrow phase for one candidate pair. */
export function collides(
  a: AnyEntity,
  b: AnyEntity,
  bounds: { width: number; height: number },
): boolean {
  if (circlesOverlap(a, b)) return true;
  const r = a.radius + b.radius;
  if (a.kind === 'bullet' && b.kind !== 'bullet')
    return segmentHitsCircle(a.prevPos, a.pos, b.pos, r, bounds);
  if (b.kind === 'bullet' && a.kind !== 'bullet')
    return segmentHitsCircle(b.prevPos, b.pos, a.pos, r, bounds);
  return false;
}

/** Every colliding pair of collidable, alive entities — naive O(n²), kept as the reference. */
export const findCollisions: CollisionSystem = (world) => {
  const list: AnyEntity[] = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);

  const pairs: CollisionPair[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b && collides(a, b, world)) pairs.push([a, b]);
    }
  }
  return pairs;
};
