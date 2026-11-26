import { Vector2 } from './vector.js';
import { findCollisions } from './collision.js';
import { homingSystem } from './components.js';

// Small seeded PRNG (mulberry32): same seed + same inputs = same game. Needed for Lab 5.
export function createRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// World is an EventTarget: it announces what happened ("fired", "hit", "exploded", ...)
// and audio/HUD subscribe. The simulation never imports audio or HUD code.
export class World extends EventTarget {
  // Map<id, Entity>: number keys stay numbers, real .size, insertion order, no inherited keys.
  #entities = new Map();
  // Deferred structural changes: never add/remove from the Map while systems iterate it.
  #pendingSpawn = [];
  #pendingDespawn = new Set();

  constructor({ width, height, seed = 1, collisions = findCollisions, onCollision = () => {} }) {
    super();
    this.width = width;
    this.height = height;
    this.rng = createRng(seed);
    this.time = 0;
    this.tick = 0;
    this.stepping = false;
    // Swappable systems (Lab 7: replace `collisions` with a spatial hash).
    this.collisions = collisions;
    this.onCollision = onCollision;
    this.systems = []; // extra (world, dt) => void systems, e.g. the spawn director
  }

  /** Dispatches synchronously. Listeners must only READ the event — never mutate the sim. */
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get size() {
    return this.#entities.size;
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const e of this) if (e.kind === kind) yield e;
  }

  get(id) {
    return this.#entities.get(id);
  }

  countOfKind(kind) {
    let n = 0;
    for (const e of this) if (e.kind === kind && e.alive) n++;
    return n;
  }

  /** Adds immediately if we're between steps, otherwise at the end of the current step. */
  spawn(entity) {
    if (this.stepping) this.#pendingSpawn.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Deferred: marks dead now (so nothing else hits it this step), removes in sweep(). */
  despawn(id) {
    const e = this.#entities.get(id);
    if (e) e.kill();
    this.#pendingDespawn.add(id);
  }

  #sweep() {
    for (const id of this.#pendingDespawn) this.#entities.delete(id);
    this.#pendingDespawn.clear();
    for (const e of this.#pendingSpawn) this.#entities.set(e.id, e);
    this.#pendingSpawn.length = 0;
  }

  /**
   * One fixed simulation step.
   * @param {number} dt
   * @param {Map<number, object>} inputs  shipId -> controls
   */
  step(dt, inputs = new Map()) {
    this.stepping = true;

    for (const e of this) e.snapshot();

    for (const [shipId, controls] of inputs) {
      const ship = this.get(shipId);
      if (ship) ship.controls = controls;
    }

    homingSystem(this, dt);

    for (const e of this) {
      if (!e.alive) continue;
      e.update(dt, this);
      this.#applyEdges(e);
    }

    for (const [a, b] of this.collisions(this)) {
      // An earlier pair this step may already have killed one of them.
      if (a.alive && b.alive && a.collidable && b.collidable) this.onCollision(a, b, this);
    }

    for (const system of this.systems) system(this, dt);

    this.stepping = false;
    this.#sweep();
    this.time += dt;
    this.tick++;
  }

  #applyEdges(e) {
    const { width: w, height: h } = this;
    if (e.edge === 'bounce') {
      const r = e.radius;
      if (e.pos.x < r) {
        e.pos.x = r;
        e.vel.x = Math.abs(e.vel.x);
      } else if (e.pos.x > w - r) {
        e.pos.x = w - r;
        e.vel.x = -Math.abs(e.vel.x);
      }
      if (e.pos.y < r) {
        e.pos.y = r;
        e.vel.y = Math.abs(e.vel.y);
      } else if (e.pos.y > h - r) {
        e.pos.y = h - r;
        e.vel.y = -Math.abs(e.vel.y);
      }
    } else {
      if (e.pos.x < 0) e.pos.x += w;
      else if (e.pos.x >= w) e.pos.x -= w;
      if (e.pos.y < 0) e.pos.y += h;
      else if (e.pos.y >= h) e.pos.y -= h;
    }
  }

  /** Random point at least `clearance` px away from every collidable entity. */
  findSafeSpot(clearance = 120, attempts = 40) {
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < attempts; i++) {
      const p = new Vector2(
        clearance + this.rng() * (this.width - 2 * clearance),
        clearance + this.rng() * (this.height - 2 * clearance),
      );
      let nearest = Infinity;
      for (const e of this) {
        if (!e.alive || !e.collidable) continue;
        const d = e.pos.sub(p).length() - e.radius;
        if (d < nearest) nearest = d;
      }
      if (nearest >= clearance) return p;
      if (nearest > bestDist) {
        bestDist = nearest;
        best = p;
      }
    }
    return best ?? new Vector2(this.width / 2, this.height / 2);
  }
}
