import { Entity } from './entity.ts';
import type { World } from './world.ts';

// `as const satisfies …`: the object is checked against the shape, but keeps its literal keys,
// so `PickupEffect` is exactly 'speed' | 'bullets' | 'repair' — derived, never written twice.
export const PICKUP_TYPES = {
  speed: { duration: 10, color: '#4fc3ff', label: '»' }, // x2 plane speed for 10 s
  bullets: { duration: 10, color: '#ffd23f', label: 'B' }, // x2 bullet speed for 10 s
  repair: { duration: 0, color: '#5dff7a', label: '+' }, // instant full HP
} as const satisfies Record<string, { duration: number; color: string; label: string }>;

export type PickupEffect = keyof typeof PICKUP_TYPES;
export const PICKUP_EFFECTS = Object.keys(PICKUP_TYPES).filter(isPickupEffect);

export function isPickupEffect(s: string): s is PickupEffect {
  return Object.hasOwn(PICKUP_TYPES, s);
}

/** The component: anything carrying it is consumed by a ship that touches it. */
export interface PickupComponent {
  readonly effect: PickupEffect;
  readonly duration: number;
}

// A Pickup is NOT a ship and doesn't move: an Entity with zero velocity plus a `pickup` component.
export class Pickup extends Entity<'pickup'> {
  readonly lifetime = 15; // disappears if nobody takes it
  age = 0;

  constructor({ x, y, effect }: { x: number; y: number; effect: PickupEffect }) {
    super('pickup', { x, y, radius: 12 });
    this.pickup = { effect, duration: PICKUP_TYPES[effect].duration };
  }

  override update(dt: number, world: World): void {
    // no super.update: stationary on purpose
    this.age += dt;
    this.angle += dt;
    if (this.age >= this.lifetime) world.despawn(this.id);
  }
}
