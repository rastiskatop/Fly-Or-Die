import { dsin, dcos } from './dmath.ts';
import { Entity } from './entity.ts';
import type { World } from './world.ts';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly size: number;
}

// A short-lived cloud of particles. Particles are plain objects allocated per explosion —
// many short-lived allocations on purpose: this is the GC pressure we'll measure and pool in Lab 7.
export class Explosion extends Entity<'explosion'> {
  ttl: number;
  readonly maxTtl: number;
  readonly color: string;
  readonly particles: Particle[] = [];

  constructor({
    x,
    y,
    vx = 0,
    vy = 0,
    count = 24,
    speed = 160,
    ttl = 0.9,
    color = '#ffaa33',
    rng = Math.random,
  }: {
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    count?: number;
    speed?: number;
    ttl?: number;
    color?: string;
    rng?: () => number;
  }) {
    super('explosion', { x, y, vx: vx * 0.3, vy: vy * 0.3, radius: 0 });
    this.collidable = false;
    this.ttl = ttl;
    this.maxTtl = ttl;
    this.color = color;
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const s = speed * (0.3 + rng() * 0.7);
      this.particles.push({ x: 0, y: 0, vx: dcos(a) * s, vy: dsin(a) * s, size: 1 + rng() * 2.5 });
    }
  }

  override update(dt: number, world: World): void {
    super.update(dt, world);
    const drag = Math.pow(0.92, dt * 60); // render-only particles: engine-exact math not needed
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
    }
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
