// What the renderer needs to draw something — described by SHAPE, not by class.
// The offline World's entities (Ship, Bullet, …) and the online NetGame's plain view objects
// both satisfy these interfaces structurally; neither imports or extends them. That's
// TypeScript's structural typing doing the job an `implements Drawable` would do in Java.
import type { ShipEffect } from '@flyordie/shared/sim/ship.ts';
import type { PickupEffect } from '@flyordie/shared/sim/pickup.ts';
import type { Particle } from '@flyordie/shared/sim/explosion.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface Placed {
  readonly pos: Point;
  readonly prevPos: Point;
  readonly angle: number;
  readonly prevAngle: number;
  readonly alive: boolean;
}

export interface DrawableShip extends Placed {
  readonly kind: 'ship';
  readonly radius: number;
  readonly destroyed: boolean;
  readonly invulnerableFor: number;
  readonly hitFlash: number;
  readonly thrusting: boolean;
  readonly effects: ReadonlyMap<ShipEffect, number>;
  readonly hp: number;
  readonly maxHp: number;
}

export interface DrawableBullet extends Placed {
  readonly kind: 'bullet';
  readonly fast: boolean;
}

export interface DrawableAsteroid extends Placed {
  readonly kind: 'asteroid';
  readonly id: number;
  readonly radius: number;
  readonly homing: unknown; // only "is it a seeker?" matters to the renderer
  readonly hitFlash: number;
  readonly shape: readonly number[];
}

export interface DrawablePickup extends Placed {
  readonly kind: 'pickup';
  readonly radius: number;
  readonly pickup: { readonly effect: PickupEffect } | null;
  readonly lifetime: number;
  readonly age: number;
}

export interface DrawableExplosion extends Placed {
  readonly kind: 'explosion';
  readonly particles: readonly Particle[];
  readonly ttl: number;
  readonly maxTtl: number;
  readonly color: string;
}

export type Drawable =
  DrawableShip | DrawableBullet | DrawableAsteroid | DrawablePickup | DrawableExplosion;
export type DrawableKind = Drawable['kind'];

export interface RenderWorld {
  readonly width: number;
  readonly height: number;
  ofKind(kind: DrawableKind): Iterable<Drawable>;
}
