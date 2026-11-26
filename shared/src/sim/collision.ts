// Broad + narrow phase in one naive O(n^2) pass. Written as a standalone system that
// only *reports* pairs, so it can be swapped for a spatial hash (Lab 7) without touching
// the code that decides what a collision means.
import type { AnyEntity, World } from './world.ts';

export type CollisionPair = readonly [AnyEntity, AnyEntity];
export type CollisionSystem = (world: World) => CollisionPair[];

interface Circle {
  readonly pos: { readonly x: number; readonly y: number };
  readonly radius: number;
}

export function circlesOverlap(a: Circle, b: Circle): boolean {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const r = a.radius + b.radius;
  return dx * dx + dy * dy < r * r;
}

/** Every overlapping pair of collidable, alive entities. */
export const findCollisions: CollisionSystem = (world) => {
  const list: AnyEntity[] = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);

  const pairs: CollisionPair[] = [];
  list.forEach((a, i) => {
    for (const b of list.slice(i + 1)) if (circlesOverlap(a, b)) pairs.push([a, b]);
  });
  return pairs;
};
