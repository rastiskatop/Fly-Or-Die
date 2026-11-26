import { Entity } from './entity.ts';
import { Vector2 } from './vector.ts';
import { Bullet } from './bullet.ts';
import { dsin, dcos } from './dmath.ts';
import type { World } from './world.ts';
import type { PickupEffect } from './pickup.ts';
import { asSeq, type Seq } from '../ids.ts';

export const TURN_SPEED = 3.5; // rad/s
const THRUST = 400; // px/s^2
const MAX_SPEED = 600; // px/s
const DRAG_PER_STEP = 0.98; // at 60 Hz
const MAX_HP = 100;
const FIRE_COOLDOWN = 0.22; // s
const BULLET_SPEED = 700; // px/s, relative to the ship
const RESPAWN_DELAY = 2; // s
const SPAWN_PROTECTION = 2; // s
const SPEED_BOOST = 2; // 'speed' pickup: x2 thrust and top speed
const BULLET_BOOST = 2; // 'bullets' pickup: x2 bullet speed

export interface Controls {
  readonly left: boolean;
  readonly right: boolean;
  readonly thrust: boolean;
  readonly fire: boolean;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

/** Timed effects a ship can carry ('repair' is instant, so it is not one). */
export type ShipEffect = Exclude<PickupEffect, 'repair'>;

/** Everything stepShipMotion reads and writes — a Ship has it, and so does the client's prediction. */
export interface ShipMotionState {
  pos: Vector2;
  vel: Vector2;
  angle: number;
  readonly effects: Map<ShipEffect, number>;
  invulnerableFor: number;
  fireCooldown: number;
  thrusting: boolean;
}

/** DRAG_PER_STEP^(dt·60) — by repeated multiplication when that's a whole number (it is for
 *  1/30 and 1/60), so it doesn't depend on the engine's Math.pow. */
function dragFactor(dt: number): number {
  const n = Math.round(dt * 60);
  if (Math.abs(dt * 60 - n) > 1e-9) return Math.pow(DRAG_PER_STEP, dt * 60);
  let f = 1;
  for (let i = 0; i < n; i++) f *= DRAG_PER_STEP;
  return f;
}

export const NO_CONTROLS: Controls = Object.freeze({
  left: false,
  right: false,
  thrust: false,
  fire: false,
});
export const FIRE_COOLDOWN_S = FIRE_COOLDOWN;
export const BULLET_SPEEDS = Object.freeze({
  normal: BULLET_SPEED,
  fast: BULLET_SPEED * BULLET_BOOST,
});

/**
 * Lab 5 determinism experiment: when true, ship motion gets a pinch of Math.random() noise.
 * Only the CLIENT ever sets it (?chaos=1). Never true on the server.
 */
export const physics = { chaos: false };

/**
 * One fixed step of ship motion — THE function both the server (Ship.update) and the client's
 * prediction run. Plain arithmetic, no world access: same state + same controls →
 * bit-identical results in Node and in the browser.
 * @returns true if the ship wants to (and may) fire this step
 */
export function stepShipMotion(
  s: ShipMotionState,
  c: Controls,
  dt: number,
  bounds: Bounds,
): boolean {
  s.invulnerableFor = Math.max(0, s.invulnerableFor - dt);
  for (const [name, left] of s.effects) {
    if (left - dt <= 0) s.effects.delete(name);
    else s.effects.set(name, left - dt);
  }

  if (c.left) s.angle -= TURN_SPEED * dt;
  if (c.right) s.angle += TURN_SPEED * dt;
  // Keep the angle in (-π, π]: the binary protocol quantizes it into an Int16 range.
  if (s.angle > Math.PI) s.angle -= Math.PI * 2;
  else if (s.angle <= -Math.PI) s.angle += Math.PI * 2;

  const boost = s.effects.has('speed') ? SPEED_BOOST : 1;
  s.thrusting = c.thrust;
  let vel = s.vel;
  if (s.thrusting) {
    vel = new Vector2(
      vel.x + dcos(s.angle) * THRUST * boost * dt,
      vel.y + dsin(s.angle) * THRUST * boost * dt,
    );
  }
  vel = vel.scale(dragFactor(dt)).clampLength(MAX_SPEED * boost);
  if (physics.chaos) {
    vel = new Vector2(vel.x + (Math.random() - 0.5) * 30, vel.y + (Math.random() - 0.5) * 30); // ← the bug on purpose
  }
  s.vel = vel;

  let x = s.pos.x + vel.x * dt;
  let y = s.pos.y + vel.y * dt;
  if (x < 0) x += bounds.width;
  else if (x >= bounds.width) x -= bounds.width;
  if (y < 0) y += bounds.height;
  else if (y >= bounds.height) y -= bounds.height;
  s.pos = new Vector2(x, y);

  s.fireCooldown = Math.max(0, s.fireCooldown - dt);
  return c.fire && s.fireCooldown === 0;
}

export class Ship extends Entity<'ship'> implements ShipMotionState {
  // Private: the only way to change hp is damage()/heal(), so nobody can set hp = 9999.
  #hp = MAX_HP;
  readonly name: string;
  readonly maxHp = MAX_HP;
  controls: Controls = NO_CONTROLS;
  /** seq of the input being applied (server) — tags bullets for client prediction */
  inputSeq: Seq = asSeq(0);
  thrusting = false;
  fireCooldown = 0;
  score = 0;
  deaths = 0;
  // A destroyed ship stays in the World (same id, same score), hidden until respawnIn reaches 0.
  destroyed = false;
  respawnIn = 0;
  invulnerableFor = SPAWN_PROTECTION;
  readonly effects = new Map<ShipEffect, number>();
  hitFlash = 0;

  constructor({
    x,
    y,
    angle = -Math.PI / 2,
    name = 'P1',
  }: {
    x: number;
    y: number;
    angle?: number;
    name?: string;
  }) {
    super('ship', { x, y, angle, radius: 18 });
    this.name = name;
  }

  get hp(): number {
    return this.#hp;
  }

  get shielded(): boolean {
    return this.invulnerableFor > 0;
  }

  /** @returns true if this hit destroyed the ship */
  damage(amount: number): boolean {
    if (this.destroyed || this.shielded) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    this.hitFlash = 0.15;
    if (this.#hp === 0) {
      this.#destroy();
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    this.#hp = Math.min(MAX_HP, this.#hp + amount);
  }

  #destroy(): void {
    this.destroyed = true;
    this.collidable = false;
    this.respawnIn = RESPAWN_DELAY;
    this.deaths++;
    this.effects.clear();
    this.vel = Vector2.ZERO;
  }

  respawn(x: number, y: number): void {
    this.#hp = MAX_HP;
    this.destroyed = false;
    this.collidable = true;
    this.invulnerableFor = SPAWN_PROTECTION;
    this.pos = new Vector2(x, y);
    this.prevPos = this.pos; // don't interpolate from the death spot
    this.vel = Vector2.ZERO;
    this.angle = -Math.PI / 2;
    this.prevAngle = this.angle;
  }

  applyPickup(effect: PickupEffect, duration: number): void {
    if (effect === 'repair') {
      this.heal(MAX_HP); // full repair
      return;
    }
    this.effects.set(effect, duration);
  }

  override update(dt: number, world: World): void {
    this.hitFlash = Math.max(0, this.hitFlash - dt);

    if (this.destroyed) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) {
        const spot = world.findSafeSpot(this.radius * 8);
        this.respawn(spot.x, spot.y);
        world.emit('respawned', { shipId: this.id, x: spot.x, y: spot.y });
      }
      return;
    }

    if (stepShipMotion(this, this.controls, dt, world)) this.fire(world);
  }

  // A regular prototype method: `this` depends on HOW it is called (Lab 2's "this bug").
  fire(world: World): Bullet | null {
    if (this.destroyed) return null;
    this.fireCooldown = FIRE_COOLDOWN;

    const dir = Vector2.fromAngle(this.angle);
    const nose = this.pos.add(dir.scale(this.radius + 10));
    // Inherited velocity: bullet speed is relative to the ship.
    const fast = this.effects.has('bullets');
    const vel = this.vel.add(dir.scale(BULLET_SPEED * (fast ? BULLET_BOOST : 1)));

    const bullet = new Bullet({ x: nose.x, y: nose.y, vx: vel.x, vy: vel.y, ownerId: this.id });
    bullet.fast = fast;
    bullet.spawnSeq = this.inputSeq;
    world.emit('fired', { shipId: this.id, x: nose.x, y: nose.y, fast });
    return world.spawn(bullet);
  }
}
