import { Vector2 } from './vector.ts';
import { asEntityId, type EntityId } from '../ids.ts';
import type { World } from './world.ts';
import type { Homing } from './components.ts';
import type { PickupComponent } from './pickup.ts';

export type EntityKind = 'ship' | 'bullet' | 'asteroid' | 'pickup' | 'explosion';
export type EdgeMode = 'wrap' | 'bounce';

export interface EntityInit {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  angle?: number;
  radius?: number;
}

/**
 * Base class for everything that lives in the World. `K` is the literal kind ('ship', …),
 * so `Ship extends Entity<'ship'>` has `kind: 'ship'` and a union of entities can be
 * narrowed with `if (e.kind === 'ship')`. Inheritance stays one level deep (Lab 2);
 * behaviours like homing and pickups are components (see components.ts).
 */
export abstract class Entity<K extends EntityKind = EntityKind> {
  // Private static counter. Ids travel as Uint16 in the binary protocol → wrap at 65535.
  static #nextId = 1;
  readonly #id: EntityId = Entity.#allocId();

  static #allocId(): EntityId {
    const id = Entity.#nextId;
    Entity.#nextId = id >= 0xffff ? 1 : id + 1;
    return asEntityId(id);
  }

  readonly kind: K;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  alive = true;
  /** What the arena does at the border. */
  edge: EdgeMode = 'wrap';
  /** Whether the collision system considers this entity at all. */
  collidable = true;
  /** For elastic bounces; asteroids override it with radius². */
  mass = 400;

  // Optional components (Lab 2 composition) — any entity may carry them.
  homing: Homing | null = null;
  pickup: PickupComponent | null = null;

  // Previous-step state for render interpolation (Lab 1).
  prevPos: Vector2;
  prevAngle: number;

  constructor(kind: K, { x = 0, y = 0, vx = 0, vy = 0, angle = 0, radius = 10 }: EntityInit = {}) {
    this.kind = kind;
    this.pos = new Vector2(x, y);
    this.vel = new Vector2(vx, vy);
    this.angle = angle;
    this.radius = radius;
    this.prevPos = this.pos;
    this.prevAngle = angle;
  }

  get id(): EntityId {
    return this.#id;
  }

  /** Called by World before every fixed step. Vectors are immutable, so sharing is safe. */
  snapshot(): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Default behaviour: inertial motion. Subclasses call super.update(). */
  update(dt: number, _world: World): void {
    this.pos = this.pos.addScaled(this.vel, dt);
  }

  kill(): void {
    this.alive = false;
  }
}
