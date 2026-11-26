import { dsin, dcos } from './dmath.ts';
import { Entity } from './entity.ts';
import type { World } from './world.ts';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
}

// ---------- particle pool (Lab 7) ----------
// A ship explosion is 60 particles that live ~0.9 s: long enough to survive a scavenge or two and
// get promoted, so they ended up in the OLD generation (major GC work) — the textbook case for a
// pool (Nystrom, "Object Pool"). Particles are recycled through a free list instead of `new`.
// Bounded, so a burst of explosions can't pin memory forever. The random numbers are drawn exactly
// as before, so the simulation (and its determinism hash) is unchanged.
const MAX_POOLED = 4096;
const free: Particle[] = [];
export const particlePool = {
  created: 0,
  reused: 0,
  get available(): number {
    return free.length;
  },
};

function acquireParticle(vx: number, vy: number, size: number): Particle {
  const p = free.pop();
  if (!p) {
    particlePool.created++;
    return { x: 0, y: 0, vx, vy, size }; // always this field order → one hidden class
  }
  particlePool.reused++;
  p.x = 0;
  p.y = 0;
  p.vx = vx;
  p.vy = vy;
  p.size = size;
  return p;
}

function releaseParticles(list: Particle[]): void {
  for (const p of list) if (free.length < MAX_POOLED) free.push(p);
  list.length = 0;
}

// A short-lived cloud of particles; the particle objects come from the pool above.
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
      this.particles.push(acquireParticle(dcos(a) * s, dsin(a) * s, 1 + rng() * 2.5));
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
    if (this.ttl <= 0) {
      releaseParticles(this.particles); // back to the pool; nothing draws a dead explosion's particles
      world.despawn(this.id);
    }
  }
}
