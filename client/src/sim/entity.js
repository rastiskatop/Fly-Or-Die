import { Vector2 } from './vector.js';

// Base class for everything that lives in the World.
// Rule of this codebase: inheritance is at most ONE level deep (Ship extends Entity).
// Shared behaviour that doesn't fit "is-a" (homing, pickup effects) is attached as
// components — see components.js.
export class Entity {
  // Private static counter: nobody outside the class can reset or read it.
  static #nextId = 1;
  #id = Entity.#nextId++;

  constructor({ kind, x = 0, y = 0, vx = 0, vy = 0, angle = 0, radius = 10 }) {
    this.kind = kind;
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(vx, vy);
    this.angle = angle;
    this.radius = radius;
    this.alive = true;

    // What the arena does at the border: 'wrap' (teleport across) or 'bounce'.
    this.edge = 'wrap';
    // Whether the collision system should consider this entity at all.
    this.collidable = true;

    // Previous-step snapshot for render interpolation (see Lab 1).
    this.prevPos = this.pos.clone();
    this.prevAngle = angle;
  }

  get id() {
    return this.#id;
  }

  // Called by World before every fixed step.
  snapshot() {
    this.prevPos.copyFrom(this.pos);
    this.prevAngle = this.angle;
  }

  // Default behaviour: inertial motion. Subclasses call super.update(dt).
  // eslint-disable-next-line no-unused-vars
  update(dt, world) {
    this.pos.addScaledInPlace(this.vel, dt);
  }

  kill() {
    this.alive = false;
  }
}
