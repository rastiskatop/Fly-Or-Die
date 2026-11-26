import { Entity } from './entity.ts';
import type { World } from './world.ts';

/** 3 = big, 2 = medium, 1 = small. A destroyed asteroid splits into two of size − 1. */
export type AsteroidSize = 1 | 2 | 3;

export const ASTEROID_RADIUS: Readonly<Record<AsteroidSize, number>> = { 1: 14, 2: 26, 3: 42 };
const HP: Readonly<Record<AsteroidSize, number>> = { 1: 25, 2: 50, 3: 100 };
export const ASTEROID_SCORE: Readonly<Record<AsteroidSize, number>> = { 1: 30, 2: 20, 3: 10 };

export function isAsteroidSize(n: number): n is AsteroidSize {
  return n === 1 || n === 2 || n === 3;
}

export class Asteroid extends Entity<'asteroid'> {
  #hp: number;
  readonly size: AsteroidSize;
  readonly spin: number;
  hitFlash = 0;
  /** Irregular outline, generated once (render-only data). */
  readonly shape: readonly number[];

  constructor({
    x,
    y,
    vx,
    vy,
    size = 3,
    rng = Math.random,
  }: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size?: AsteroidSize;
    rng?: () => number;
  }) {
    super('asteroid', { x, y, vx, vy, angle: rng() * Math.PI * 2, radius: ASTEROID_RADIUS[size] });
    this.size = size;
    this.#hp = HP[size];
    this.spin = (rng() - 0.5) * 1.5; // rad/s
    this.edge = 'bounce';
    this.mass = this.radius * this.radius;
    this.shape = Array.from({ length: 11 }, () => 0.75 + rng() * 0.3);
  }

  get hp(): number {
    return this.#hp;
  }

  /** @returns true if destroyed */
  damage(amount: number): boolean {
    this.#hp -= amount;
    this.hitFlash = 0.1;
    return this.#hp <= 0;
  }

  override update(dt: number, world: World): void {
    super.update(dt, world);
    this.angle += this.spin * dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
  }
}
