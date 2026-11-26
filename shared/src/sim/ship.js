import { Entity } from './entity.js';
import { Vector2 } from './vector.js';
import { Bullet } from './bullet.js';
import { dsin, dcos } from './dmath.js';

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

/** DRAG_PER_STEP^(dt·60) — by repeated multiplication when that's a whole number (it is for
 *  1/30 and 1/60), so it doesn't depend on the engine's Math.pow. */
function dragFactor(dt) {
  const n = Math.round(dt * 60);
  if (Math.abs(dt * 60 - n) > 1e-9) return Math.pow(DRAG_PER_STEP, dt * 60);
  let f = 1;
  for (let i = 0; i < n; i++) f *= DRAG_PER_STEP;
  return f;
}

export const NO_CONTROLS = Object.freeze({ left: false, right: false, thrust: false, fire: false });
export const FIRE_COOLDOWN_S = FIRE_COOLDOWN;
export const BULLET_SPEEDS = Object.freeze({
  normal: BULLET_SPEED,
  fast: BULLET_SPEED * BULLET_BOOST,
});

/**
 * Lab 5 determinism experiment: when true, ship motion gets a pinch of Math.random() noise.
 * Only the CLIENT ever sets it (?chaos=1) — so its prediction diverges from the server and the
 * netgraph's correction graph lights up. Never true on the server.
 */
export const physics = { chaos: false };

/**
 * One fixed step of ship motion — THE function both the server (Ship.update) and the client's
 * prediction run. Pure arithmetic on plain fields, no world access, so given the same state and
 * the same controls it gives bit-identical results in Node and in the browser.
 * Mutates `s` ({ pos, vel, angle, effects, invulnerableFor, fireCooldown, thrusting }).
 * @returns {boolean} true if the ship wants to (and may) fire this step
 */
export function stepShipMotion(s, c, dt, bounds) {
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
  if (s.thrusting) {
    s.vel.x += dcos(s.angle) * THRUST * boost * dt;
    s.vel.y += dsin(s.angle) * THRUST * boost * dt;
  }
  s.vel.scaleInPlace(dragFactor(dt));
  s.vel.clampLengthInPlace(MAX_SPEED * boost);
  if (physics.chaos) {
    s.vel.x += (Math.random() - 0.5) * 30; // ← the bug on purpose
    s.vel.y += (Math.random() - 0.5) * 30;
  }

  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  if (s.pos.x < 0) s.pos.x += bounds.width;
  else if (s.pos.x >= bounds.width) s.pos.x -= bounds.width;
  if (s.pos.y < 0) s.pos.y += bounds.height;
  else if (s.pos.y >= bounds.height) s.pos.y -= bounds.height;

  s.fireCooldown = Math.max(0, s.fireCooldown - dt);
  return c.fire && s.fireCooldown === 0;
}

export class Ship extends Entity {
  // Private: the only way to change hp is damage()/heal(), so nobody can set hp = 9999.
  #hp = MAX_HP;

  constructor({ x, y, angle = -Math.PI / 2, name = 'P1' }) {
    super({ kind: 'ship', x, y, angle, radius: 18 });
    this.name = name;
    this.maxHp = MAX_HP;
    this.controls = NO_CONTROLS;
    this.inputSeq = 0; // seq of the input being applied (server) — tags bullets for client prediction
    this.thrusting = false;
    this.fireCooldown = 0;

    this.score = 0;
    this.deaths = 0;

    // Respawn state: a destroyed ship stays in the World (same id, same score),
    // it is just hidden and non-collidable until respawnIn reaches 0.
    this.destroyed = false;
    this.respawnIn = 0;
    this.invulnerableFor = SPAWN_PROTECTION;

    // Active pickup effects: Map<effectName, secondsLeft>.
    this.effects = new Map();

    this.hitFlash = 0;
  }

  get hp() {
    return this.#hp;
  }

  get shielded() {
    return this.invulnerableFor > 0;
  }

  /** @returns {boolean} true if this hit destroyed the ship */
  damage(amount) {
    if (this.destroyed || this.shielded) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    this.hitFlash = 0.15;
    if (this.#hp === 0) {
      this.#destroy();
      return true;
    }
    return false;
  }

  heal(amount) {
    this.#hp = Math.min(MAX_HP, this.#hp + amount);
  }

  #destroy() {
    this.destroyed = true;
    this.collidable = false;
    this.respawnIn = RESPAWN_DELAY;
    this.deaths++;
    this.effects.clear();
    this.vel.set(0, 0);
  }

  respawn(x, y) {
    this.#hp = MAX_HP;
    this.destroyed = false;
    this.collidable = true;
    this.invulnerableFor = SPAWN_PROTECTION;
    this.pos.set(x, y);
    this.prevPos.copyFrom(this.pos); // don't interpolate from the death spot
    this.vel.set(0, 0);
    this.angle = -Math.PI / 2;
    this.prevAngle = this.angle;
  }

  applyPickup(effect, duration) {
    if (effect === 'repair') {
      this.heal(MAX_HP); // full repair
      return;
    }
    this.effects.set(effect, duration);
  }

  update(dt, world) {
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

  // A regular prototype method: `this` depends on HOW it is called.
  // ship.fire(world) works; passing `ship.fire` as a callback does not — see README "The this bug".
  fire(world) {
    if (this.destroyed) return null;
    this.fireCooldown = FIRE_COOLDOWN;

    const dir = Vector2.fromAngle(this.angle);
    const nose = this.pos.add(dir.scale(this.radius + 10));
    // Inherited velocity: bullet speed is relative to the ship.
    const fast = this.effects.has('bullets');
    const vel = this.vel.add(dir.scale(BULLET_SPEED * (fast ? BULLET_BOOST : 1)));

    const bullet = new Bullet({ x: nose.x, y: nose.y, vx: vel.x, vy: vel.y, ownerId: this.id });
    bullet.fast = fast;
    bullet.spawnSeq = this.inputSeq; // lets the shooter's client match its predicted bullet
    world.emit('fired', { shipId: this.id, x: nose.x, y: nose.y, fast });
    return world.spawn(bullet);
  }
}
