import { Vector2 } from './vector.ts';
import { findCollisions, type CollisionSystem } from './collision.ts';
import { homingSystem } from './components.ts';
import { Bus } from '../bus.ts';
import type { EntityId } from '../ids.ts';
import type { GameEvents } from './events.ts';
import type { Ship, Controls } from './ship.ts';
import type { Bullet } from './bullet.ts';
import type { Asteroid } from './asteroid.ts';
import type { Pickup } from './pickup.ts';
import type { Explosion } from './explosion.ts';
import type { EntityKind } from './entity.ts';
import { DEFAULT_ARENA, type ArenaRules } from './arena.ts';

/** Every concrete entity — a discriminated union on `kind`. */
export type AnyEntity = Ship | Bullet | Asteroid | Pickup | Explosion;
/** 'ship' → Ship, 'bullet' → Bullet, … — derived from the union, not written by hand. */
export type EntityOfKind<K extends EntityKind> = Extract<AnyEntity, { kind: K }>;

export type Rng = () => number;
export type WorldSystem = (world: World, dt: number) => void;
export type CollisionHandler = (a: AnyEntity, b: AnyEntity, world: World) => void;

// Small seeded PRNG (mulberry32): same seed + same inputs = same game.
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isKind<K extends EntityKind>(e: AnyEntity, kind: K): e is EntityOfKind<K> {
  return e.kind === kind;
}

/**
 * The world announces what happened on a typed Bus ("fired", "hit", …); audio/HUD/network
 * subscribe. The simulation never imports any of them.
 */
export class World {
  // Map<id, Entity>: number keys stay numbers, real .size, insertion order, no inherited keys.
  readonly #entities = new Map<EntityId, AnyEntity>();
  // Deferred structural changes: never add/remove from the Map while systems iterate it.
  readonly #pendingSpawn: AnyEntity[] = [];
  readonly #pendingDespawn = new Set<EntityId>();

  readonly width: number;
  readonly height: number;
  readonly rng: Rng;
  readonly events = new Bus<GameEvents>();
  time = 0;
  tick = 0;
  stepping = false;
  /** Swappable systems (Lab 7: replace `collisions` with a spatial hash). */
  collisions: CollisionSystem;
  onCollision: CollisionHandler;
  readonly systems: WorldSystem[] = [];
  /** Game rules attached by createMatchWorld (arena config). */
  rules: ArenaRules = DEFAULT_ARENA;

  constructor({
    width,
    height,
    seed = 1,
    collisions = findCollisions,
    onCollision = () => {},
  }: {
    width: number;
    height: number;
    seed?: number;
    collisions?: CollisionSystem;
    onCollision?: CollisionHandler;
  }) {
    this.width = width;
    this.height = height;
    this.rng = createRng(seed);
    this.collisions = collisions;
    this.onCollision = onCollision;
  }

  /** Synchronous. Listeners must only READ the payload — never mutate the sim. */
  emit<K extends keyof GameEvents>(type: K, detail: GameEvents[K]): void {
    this.events.emit(type, detail);
  }

  get size(): number {
    return this.#entities.size;
  }

  /** The Map's own iterator (Lab 7: a generator here allocated a result object per entity per loop). */
  [Symbol.iterator](): IterableIterator<AnyEntity> {
    return this.#entities.values();
  }

  /** `for (const s of world.ofKind('ship'))` — s is typed as Ship, no cast. */
  *ofKind<K extends EntityKind>(kind: K): Generator<EntityOfKind<K>> {
    for (const e of this) if (isKind(e, kind)) yield e;
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  countOfKind(kind: EntityKind): number {
    let n = 0;
    for (const e of this) if (e.kind === kind && e.alive) n++;
    return n;
  }

  /** Adds immediately if we're between steps, otherwise at the end of the current step. */
  spawn<T extends AnyEntity>(entity: T): T {
    if (this.stepping) this.#pendingSpawn.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Deferred: marks dead now (so nothing else hits it this step), removes in sweep(). */
  despawn(id: EntityId): void {
    this.#entities.get(id)?.kill();
    this.#pendingDespawn.add(id);
  }

  #sweep(): void {
    for (const id of this.#pendingDespawn) this.#entities.delete(id);
    this.#pendingDespawn.clear();
    for (const e of this.#pendingSpawn) this.#entities.set(e.id, e);
    this.#pendingSpawn.length = 0;
  }

  /** One fixed simulation step. `inputs`: shipId → controls. */
  step(dt: number, inputs: ReadonlyMap<EntityId, Controls> = new Map()): void {
    this.stepping = true;

    for (const e of this) e.snapshot();

    for (const [shipId, controls] of inputs) {
      const ship = this.get(shipId);
      if (ship?.kind === 'ship') ship.controls = controls;
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

  #applyEdges(e: AnyEntity): void {
    const { width: w, height: h } = this;
    const { x, y } = e.pos;
    if (e.edge === 'bounce') {
      const r = e.radius;
      if (x < r) {
        e.pos = e.pos.withX(r);
        e.vel = e.vel.withX(Math.abs(e.vel.x));
      } else if (x > w - r) {
        e.pos = e.pos.withX(w - r);
        e.vel = e.vel.withX(-Math.abs(e.vel.x));
      }
      if (y < r) {
        e.pos = e.pos.withY(r);
        e.vel = e.vel.withY(Math.abs(e.vel.y));
      } else if (y > h - r) {
        e.pos = e.pos.withY(h - r);
        e.vel = e.vel.withY(-Math.abs(e.vel.y));
      }
    } else {
      let nx = x;
      let ny = y;
      if (nx < 0) nx += w;
      else if (nx >= w) nx -= w;
      if (ny < 0) ny += h;
      else if (ny >= h) ny -= h;
      if (nx !== x || ny !== y) e.pos = new Vector2(nx, ny);
    }
  }

  /** Random point at least `clearance` px away from every collidable entity. */
  findSafeSpot(clearance = 120, attempts = 40): Vector2 {
    let best: Vector2 | null = null;
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
