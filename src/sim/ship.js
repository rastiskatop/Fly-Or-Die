import { Entity } from './entity.js';
import { Vector2 } from './vector.js';
import { Bullet } from './bullet.js';

const TURN_SPEED = 3.5; // rad/s
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

export const NO_CONTROLS = Object.freeze({ left: false, right: false, thrust: false, fire: false });

export class Ship extends Entity {
  // Private: the only way to change hp is damage()/heal(), so nobody can set hp = 9999.
  #hp = MAX_HP;

  constructor({ x, y, angle = -Math.PI / 2, name = 'P1' }) {
    super({ kind: 'ship', x, y, angle, radius: 18 });
    this.name = name;
    this.maxHp = MAX_HP;
    this.controls = NO_CONTROLS;
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
      }
      return;
    }

    this.invulnerableFor = Math.max(0, this.invulnerableFor - dt);
    for (const [name, left] of this.effects) {
      if (left - dt <= 0) this.effects.delete(name);
      else this.effects.set(name, left - dt);
    }

    const c = this.controls;
    if (c.left) this.angle -= TURN_SPEED * dt;
    if (c.right) this.angle += TURN_SPEED * dt;

    const boost = this.effects.has('speed') ? SPEED_BOOST : 1;
    this.thrusting = c.thrust;
    if (this.thrusting) {
      this.vel.addScaledInPlace(Vector2.fromAngle(this.angle), THRUST * boost * dt);
    }
    this.vel.scaleInPlace(Math.pow(DRAG_PER_STEP, dt * 60));
    this.vel.clampLengthInPlace(MAX_SPEED * boost);

    super.update(dt, world);

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (c.fire && this.fireCooldown === 0) this.fire(world);
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
    return world.spawn(bullet);
  }
}
