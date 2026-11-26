// Remote entities as REUSED, mutable view objects (Lab 7, M3 — measured top allocator).
//
// Before: every frame, for every entity, `lerpEntity` spread-copied the snapshot state, `toView`
// built a new object + Vector2 + (ships) a new effects Map, and RenderWorld.ofKind was a generator
// (one iterator-result object per yielded entity). ~40 MB per 30 s at 8 bots, and because the
// client kept 2 s of snapshots alive, much of it was promoted → major GCs.
//
// Now: one view object per entity id, created once and updated IN PLACE each frame; lists per
// kind are arrays reused across frames (length = 0, push). Steady state: zero allocation.
// Every view of one kind is created by the same factory, so they share one hidden class — the
// draw functions' property loads stay monomorphic.
import { ASTEROID_RADIUS } from '@flyordie/shared/sim/asteroid.ts';
import type { EntityState } from '@flyordie/shared/net/protocol.ts';
import type { EntityId } from '@flyordie/shared/ids.ts';
import type { Bounds, ShipEffect } from '@flyordie/shared/sim/ship.ts';
import type { PickupEffect } from '@flyordie/shared/sim/pickup.ts';
import type { Drawable, DrawableKind } from '../render/types.ts';

interface Pt {
  x: number;
  y: number;
}

interface ViewBase {
  pos: Pt;
  prevPos: Pt; // the SAME object as pos: remote entities are already interpolated
  angle: number;
  prevAngle: number;
  alive: boolean;
  seen: number;
}
export interface ShipView extends ViewBase {
  readonly kind: 'ship';
  readonly radius: number;
  readonly maxHp: number;
  hp: number;
  destroyed: boolean;
  thrusting: boolean;
  hitFlash: number;
  invulnerableFor: number;
  readonly effects: Map<ShipEffect, number>;
}
export interface BulletView extends ViewBase {
  readonly kind: 'bullet';
  fast: boolean;
}
export interface AsteroidView extends ViewBase {
  readonly kind: 'asteroid';
  id: number;
  radius: number;
  homing: true | null;
  hitFlash: number;
  shape: readonly number[];
}
export interface PickupView extends ViewBase {
  readonly kind: 'pickup';
  readonly radius: number;
  readonly pickup: { effect: PickupEffect };
  readonly lifetime: number;
  age: number;
}
export type RemoteView = ShipView | BulletView | AsteroidView | PickupView;

// Compile-time check: every view IS a Drawable (structural typing, no `implements` needed).
const _drawable: (v: RemoteView) => Drawable = (v) => v;
void _drawable;

/** Draw lists by kind, reused frame after frame. */
export type DrawLists = Record<DrawableKind, Drawable[]>;
export function createDrawLists(): DrawLists {
  return { ship: [], bullet: [], asteroid: [], pickup: [], explosion: [] };
}
export function clearDrawLists(lists: DrawLists): void {
  lists.ship.length = 0;
  lists.bullet.length = 0;
  lists.asteroid.length = 0;
  lists.pickup.length = 0;
  lists.explosion.length = 0;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return a + d * t;
}

const shapeCache = new Map<number, readonly number[]>();
/** A rock's outline from its id (deterministic). Bounded: ids are 1..65535. */
export function rockShape(id: number): readonly number[] {
  let shape = shapeCache.get(id);
  if (!shape) {
    let s = id * 2654435761;
    shape = Array.from({ length: 11 }, () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return 0.75 + (s / 4294967296) * 0.3;
    });
    shapeCache.set(id, shape);
  }
  return shape;
}

function create(e: EntityState): RemoteView {
  const pos = { x: e.x, y: e.y };
  switch (e.kind) {
    case 'ship':
      return {
        kind: 'ship',
        pos,
        prevPos: pos,
        angle: 0,
        prevAngle: 0,
        alive: true,
        seen: 0,
        radius: 18,
        maxHp: 100,
        hp: 0,
        destroyed: false,
        thrusting: false,
        hitFlash: 0,
        invulnerableFor: 0,
        effects: new Map(),
      };
    case 'bullet':
      return {
        kind: 'bullet',
        pos,
        prevPos: pos,
        angle: 0,
        prevAngle: 0,
        alive: true,
        seen: 0,
        fast: false,
      };
    case 'asteroid':
      return {
        kind: 'asteroid',
        pos,
        prevPos: pos,
        angle: 0,
        prevAngle: 0,
        alive: true,
        seen: 0,
        id: e.id,
        radius: ASTEROID_RADIUS[e.size],
        homing: null,
        hitFlash: 0,
        shape: rockShape(e.id),
      };
    case 'pickup':
      return {
        kind: 'pickup',
        pos,
        prevPos: pos,
        angle: 0,
        prevAngle: 0,
        alive: true,
        seen: 0,
        radius: 12,
        pickup: { effect: e.effect },
        lifetime: 15,
        age: 0,
      };
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

/** Writes b's state into `v`, positions blended from a (the previous snapshot) at t. No allocation. */
function update(v: RemoteView, a: EntityState, b: EntityState, t: number, bounds: Bounds): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // a new entity, t = 1, or a jump through the wrap: no blending (don't streak across the arena)
  if (a === b || t >= 1 || Math.abs(dx) > bounds.width / 2 || Math.abs(dy) > bounds.height / 2) {
    v.pos.x = b.x;
    v.pos.y = b.y;
    v.angle = b.angle;
  } else {
    v.pos.x = a.x + dx * t;
    v.pos.y = a.y + dy * t;
    v.angle = lerpAngle(a.angle, b.angle, t);
  }
  v.prevAngle = v.angle;
  if (v.kind === 'ship' && b.kind === 'ship') {
    v.hp = b.hp;
    v.destroyed = b.destroyed;
    v.thrusting = b.thrusting;
    v.hitFlash = b.hitFlash ? 0.1 : 0;
    v.invulnerableFor = b.invulnerable;
    // set/delete, never clear(): Map.clear() gives the map a NEW backing table every call.
    if (b.speed > 0) v.effects.set('speed', b.speed);
    else v.effects.delete('speed');
    if (b.bullets > 0) v.effects.set('bullets', b.bullets);
    else v.effects.delete('bullets');
  } else if (v.kind === 'bullet' && b.kind === 'bullet') {
    v.fast = b.fast;
    v.angle = v.prevAngle = Math.atan2(b.vy, b.vx);
  } else if (v.kind === 'asteroid' && b.kind === 'asteroid') {
    v.homing = b.seeker ? true : null;
    v.hitFlash = b.hitFlash ? 0.1 : 0;
  } else if (v.kind === 'pickup' && b.kind === 'pickup') {
    v.pickup.effect = b.effect;
    v.age = 15 - b.lifeLeft;
  }
}

const ID_SPACE = 0x10000; // entity ids are u16 on the wire: 1..65535

export class RemoteViews {
  readonly #views = new Map<EntityId, RemoteView>();
  #frame = 0;
  // "Previous state of entity N" without a Map per snapshot: a flat array indexed by id, valid
  // where the stamp matches. Re-indexed only when the older snapshot changes (30×/s); every
  // lookup is then two array reads. Preallocated once (a typed array + a packed array of nulls).
  readonly #prevState: (EntityState | null)[] = new Array<EntityState | null>(ID_SPACE).fill(null);
  readonly #prevStamp = new Int32Array(ID_SPACE);
  #stamp = 0;
  #indexed: readonly EntityState[] | null = null;
  // Views of entities that vanished, kept for the next entity of the same kind. Bullets are the
  // case that matters: ~36 new ones per second with 8 bots, each living 1.2 s — long enough to be
  // promoted, short enough to die in the old generation (Lab 7, measured).
  readonly #free: {
    ship: ShipView[];
    bullet: BulletView[];
    asteroid: AsteroidView[];
    pickup: PickupView[];
  } = {
    ship: [],
    bullet: [],
    asteroid: [],
    pickup: [],
  };
  created = 0;
  reused = 0;

  #obtain(e: EntityState): RemoteView {
    let v: RemoteView | undefined;
    switch (e.kind) {
      case 'ship': {
        const s = this.#free.ship.pop();
        if (s) s.effects.clear(); // rare (a ship id reappearing), so clear() is fine here
        v = s;
        break;
      }
      case 'bullet':
        v = this.#free.bullet.pop();
        break;
      case 'asteroid': {
        const a = this.#free.asteroid.pop();
        if (a) {
          a.id = e.id;
          a.radius = ASTEROID_RADIUS[e.size];
          a.shape = rockShape(e.id);
        }
        v = a;
        break;
      }
      case 'pickup':
        v = this.#free.pickup.pop();
        break;
    }
    if (v) {
      this.reused++;
      v.pos.x = e.x;
      v.pos.y = e.y;
      return v;
    }
    this.created++;
    return create(e);
  }

  #release(v: RemoteView): void {
    switch (v.kind) {
      case 'ship':
        this.#free.ship.push(v);
        break;
      case 'bullet':
        this.#free.bullet.push(v);
        break;
      case 'asteroid':
        this.#free.asteroid.push(v);
        break;
      case 'pickup':
        this.#free.pickup.push(v);
        break;
    }
  }
  // Created once: `for (const [id, v] of map)` would allocate an [id, v] pair per entry per frame.
  readonly #dropStale = (v: RemoteView, id: EntityId): void => {
    if (v.seen === this.#frame) return;
    this.#views.delete(id);
    this.#release(v);
  };

  /** How many view objects are alive (for tests: it must not grow without bound). */
  get size(): number {
    return this.#views.size;
  }

  /**
   * One frame: every entity of `to` (minus those `skip` rejects), blended from its state in
   * `from` at `t`, into `lists`. Views of entities that disappeared are dropped.
   */
  update(
    from: readonly EntityState[],
    to: readonly EntityState[],
    t: number,
    bounds: Bounds,
    skip: (e: EntityState) => boolean,
    lists: DrawLists,
  ): void {
    const frame = ++this.#frame;
    if (from !== this.#indexed) {
      const stamp = ++this.#stamp;
      for (let i = 0; i < from.length; i++) {
        const e = from[i];
        if (!e) continue;
        this.#prevState[e.id] = e;
        this.#prevStamp[e.id] = stamp;
      }
      this.#indexed = from;
    }
    for (const e of to) {
      if (skip(e)) continue;
      let v = this.#views.get(e.id);
      if (!v || v.kind !== e.kind) {
        if (v) this.#release(v); // the id now belongs to a different kind (ids wrap)
        v = this.#obtain(e); // first sight: a recycled view of this kind, or a new one
        this.#views.set(e.id, v);
      }
      const prev = this.#prevStamp[e.id] === this.#stamp ? this.#prevState[e.id] : null;
      update(v, prev ?? e, e, t, bounds);
      v.seen = frame;
      lists[v.kind].push(v);
    }
    this.#views.forEach(this.#dropStale); // deleting during forEach is well-defined for Maps
  }
}
