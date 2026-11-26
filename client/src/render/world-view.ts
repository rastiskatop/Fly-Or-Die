// The offline World as a RenderWorld: per-kind draw lists, reused every frame (Lab 7).
// The sim's World.ofKind is a generator — fine for game logic, but in the draw loop it made the
// iteration site polymorphic (array online, generator offline) and allocated an iterator result
// per entity. The renderer now only ever sees plain arrays.
import type { World } from '@flyordie/shared/sim/world.ts';
import type { Drawable, DrawableKind, RenderWorld } from './types.ts';

export function createWorldView(world: World): RenderWorld & { refresh(): void } {
  const lists: Record<DrawableKind, Drawable[]> = {
    ship: [],
    bullet: [],
    asteroid: [],
    pickup: [],
    explosion: [],
  };
  return {
    width: world.width,
    height: world.height,
    ofKind: (kind) => lists[kind],
    /** Call once per frame, before drawing. */
    refresh(): void {
      lists.ship.length = 0;
      lists.bullet.length = 0;
      lists.asteroid.length = 0;
      lists.pickup.length = 0;
      lists.explosion.length = 0;
      for (const e of world) lists[e.kind].push(e); // the Map's native iterator
    },
  };
}
