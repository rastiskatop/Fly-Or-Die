import { Entity } from './entity.js';

// A Pickup is NOT a ship and doesn't move: it's an Entity with zero velocity plus a
// `pickup` component (behaviour-as-data). Anything that collides with a ship and has
// a `pickup` component gets consumed — the collision handler doesn't care about the class.
export const PICKUP_TYPES = {
  speed: { duration: 10, color: '#4fc3ff', label: '»' }, // x2 plane speed for 10 s
  bullets: { duration: 10, color: '#ffd23f', label: 'B' }, // x2 bullet speed for 10 s
  repair: { duration: 0, color: '#5dff7a', label: '+' }, // instant full HP
};

export class Pickup extends Entity {
  constructor({ x, y, effect }) {
    super({ kind: 'pickup', x, y, radius: 12 });
    this.pickup = { effect, duration: PICKUP_TYPES[effect].duration };
    this.lifetime = 15; // disappears if nobody takes it
    this.age = 0;
  }

  update(dt, world) {
    // no super.update: stationary on purpose
    this.age += dt;
    this.angle += dt;
    if (this.age >= this.lifetime) world.despawn(this.id);
  }
}
