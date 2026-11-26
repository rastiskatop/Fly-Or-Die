// Broad + narrow phase in one naive O(n^2) pass. Written as a standalone system that
// only *reports* pairs, so it can be swapped for a spatial hash (Lab 7) without touching
// the code that decides what a collision means.

export function circlesOverlap(a, b) {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const r = a.radius + b.radius;
  return dx * dx + dy * dy < r * r;
}

/** @returns {Array<[Entity, Entity]>} every overlapping pair of collidable, alive entities */
export function findCollisions(world) {
  const list = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);

  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (circlesOverlap(list[i], list[j])) pairs.push([list[i], list[j]]);
    }
  }
  return pairs;
}
