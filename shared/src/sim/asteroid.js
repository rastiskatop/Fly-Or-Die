import { Entity } from './entity.js';

// size 3 = big, 2 = medium, 1 = small. A destroyed asteroid splits into two of size - 1.
export const ASTEROID_RADIUS = { 1: 14, 2: 26, 3: 42 };
const RADIUS = ASTEROID_RADIUS;
const HP = { 1: 25, 2: 50, 3: 100 };
export const ASTEROID_SCORE = { 1: 30, 2: 20, 3: 10 };

export class Asteroid extends Entity {
  #hp;

  constructor({ x, y, vx, vy, size = 3, rng = Math.random }) {
    super({ kind: 'asteroid', x, y, vx, vy, angle: rng() * Math.PI * 2, radius: RADIUS[size] });
    this.size = size;
    this.#hp = HP[size];
    this.spin = (rng() - 0.5) * 1.5; // rad/s
    this.edge = 'bounce';
    this.mass = this.radius * this.radius;
    this.hitFlash = 0;

    // Irregular rock outline, generated once (render-only data, but cheap to keep here).
    const points = 11;
    this.shape = Array.from({ length: points }, () => 0.75 + rng() * 0.3);
  }

  get hp() {
    return this.#hp;
  }

  /** @returns {boolean} true if destroyed */
  damage(amount) {
    this.#hp -= amount;
    this.hitFlash = 0.1;
    return this.#hp <= 0;
  }

  update(dt, world) {
    super.update(dt, world);
    this.angle += this.spin * dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
  }
}
