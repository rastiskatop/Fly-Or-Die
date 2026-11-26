// Game rules: what a collision MEANS, and who spawns what. The World itself stays generic.
import { World } from './world.js';
import { Ship } from './ship.js';
import { Asteroid, ASTEROID_SCORE } from './asteroid.js';
import { Explosion } from './explosion.js';
import { Pickup, PICKUP_TYPES } from './pickup.js';
import { Vector2 } from './vector.js';
import { homing } from './components.js';

const PICKUP_DROP_CHANCE = 0.12;

// Used when the arena file is missing or corrupt (Lab 3 failure gallery: the game still starts).
export const DEFAULT_ARENA = Object.freeze({
  id: 'default',
  name: 'Default',
  seed: 2026,
  asteroidMass: 4, // "big-asteroid equivalents" kept on the field
  initialAsteroids: 3,
  seekerChance: 0.3,
  pickupEvery: 9, // s
  maxPickups: 2,
  terrain: 'grass', // render-only: battlefield palette (grass / desert / snow)
});

/** A world with the arena's rules and asteroids, but no players yet (the server's Match). */
export function createMatchWorld({ width, height, arena = DEFAULT_ARENA }) {
  const rules = { ...DEFAULT_ARENA, ...arena };
  const world = new World({ width, height, seed: rules.seed, onCollision });
  world.rules = rules;

  let pickupTimer = rules.pickupEvery;
  world.systems.push(function director(w, dt) {
    let mass = 0;
    for (const a of w.ofKind('asteroid')) if (a.alive) mass += a.size / 3;
    if (mass < rules.asteroidMass) spawnAsteroidAtEdge(w);

    pickupTimer -= dt;
    if (pickupTimer <= 0) {
      pickupTimer = rules.pickupEvery;
      if (w.countOfKind('pickup') < rules.maxPickups) spawnRandomPickup(w);
    }
  });

  for (let i = 0; i < rules.initialAsteroids; i++) spawnAsteroidAtEdge(world);
  return world;
}

/** Adds a player's ship at a safe spot (deterministic: uses the world's seeded RNG). */
export function spawnPlayerShip(world, name) {
  const spot =
    world.size > 0 ? world.findSafeSpot(150) : { x: world.width / 2, y: world.height / 2 };
  return world.spawn(new Ship({ x: spot.x, y: spot.y, name }));
}

/** Offline / single-player game (Labs 1–4): a match world with one local player. */
export function createGame({ width, height, arena = DEFAULT_ARENA, playerName = 'P1' }) {
  const world = createMatchWorld({ width, height, arena });
  const player = world.spawn(new Ship({ x: width / 2, y: height / 2, name: playerName }));
  return { world, player };
}

function randomEffect(rng) {
  const effects = Object.keys(PICKUP_TYPES);
  return effects[Math.floor(rng() * effects.length)];
}

function spawnRandomPickup(world, at) {
  const p = at ?? world.findSafeSpot(60);
  world.spawn(new Pickup({ x: p.x, y: p.y, effect: randomEffect(world.rng) }));
}

function spawnAsteroidAtEdge(world) {
  const { rng, width: w, height: h } = world;
  const side = Math.floor(rng() * 4);
  const r = 44;
  const x = side === 0 ? r : side === 1 ? w - r : r + rng() * (w - 2 * r);
  const y = side === 2 ? r : side === 3 ? h - r : r + rng() * (h - 2 * r);
  // Aim roughly at the centre so it drifts across the arena.
  const toCenter = new Vector2(w / 2 - x, h / 2 - y).normalize().rotate((rng() - 0.5) * 1.2);
  const v = toCenter.scale(40 + rng() * 50);
  const asteroid = new Asteroid({ x, y, vx: v.x, vy: v.y, size: 3, rng });
  world.spawn(asteroid);
  return asteroid;
}

function explode(world, e, color, count) {
  world.spawn(
    new Explosion({
      x: e.pos.x,
      y: e.pos.y,
      vx: e.vel.x,
      vy: e.vel.y,
      color,
      count,
      speed: 80 + e.radius * 4,
      rng: world.rng,
    }),
  );
}

function destroyAsteroid(world, asteroid, killerShip) {
  world.despawn(asteroid.id);
  explode(world, asteroid, '#c8b49a', 10 + asteroid.size * 8);
  const { x, y } = asteroid.pos;
  world.emit('exploded', { kind: 'asteroid', size: asteroid.size, x, y });
  if (killerShip) {
    const points = ASTEROID_SCORE[asteroid.size];
    killerShip.score += points;
    world.emit('scored', { shipId: killerShip.id, points, total: killerShip.score, x, y });
  }

  if (asteroid.size > 1) {
    for (const sign of [-1, 1]) {
      const v = asteroid.vel.rotate(sign * (0.5 + world.rng() * 0.4)).scale(1.4);
      const offset = Vector2.fromAngle(v.angle() + (sign * Math.PI) / 2, asteroid.radius * 0.4);
      const child = new Asteroid({
        x: asteroid.pos.x + offset.x,
        y: asteroid.pos.y + offset.y,
        vx: v.x,
        vy: v.y,
        size: asteroid.size - 1,
        rng: world.rng,
      });
      // Composition: some fragments become seekers by GETTING a component, not a new subclass.
      if (child.size === 2 && world.rng() < world.rules.seekerChance) {
        child.homing = homing({ targetKinds: ['ship'], turnRate: 0.7, range: 600 });
      }
      world.spawn(child);
    }
  } else if (world.rng() < PICKUP_DROP_CHANCE) {
    spawnRandomPickup(world, asteroid.pos.clone());
  }
}

function bounceApart(a, b, restitution = 1) {
  const n = b.pos.sub(a.pos);
  const dist = n.length() || 1;
  const nx = n.x / dist;
  const ny = n.y / dist;
  const ma = a.mass ?? 400;
  const mb = b.mass ?? 400;

  // Positional correction: push out of overlap proportionally to mass.
  const overlap = a.radius + b.radius - dist;
  if (overlap > 0) {
    const total = ma + mb;
    a.pos.x -= nx * overlap * (mb / total);
    a.pos.y -= ny * overlap * (mb / total);
    b.pos.x += nx * overlap * (ma / total);
    b.pos.y += ny * overlap * (ma / total);
  }

  // Impulse along the normal (only if they're moving toward each other).
  const rel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
  if (rel >= 0) return 0;
  const j = (-(1 + restitution) * rel) / (1 / ma + 1 / mb);
  a.vel.x -= (j / ma) * nx;
  a.vel.y -= (j / ma) * ny;
  b.vel.x += (j / mb) * nx;
  b.vel.y += (j / mb) * ny;
  return -rel; // impact speed
}

/** @returns {boolean} true if the ship was destroyed */
function damageShip(world, ship, amount) {
  const hpBefore = ship.hp;
  const killed = ship.damage(amount);
  const { x, y } = ship.pos;
  if (killed) {
    explode(world, ship, '#ff7a1a', 60);
    world.emit('exploded', { kind: 'ship', shipId: ship.id, x, y });
  } else if (ship.hp < hpBefore) {
    world.emit('hit', { kind: 'ship', id: ship.id, damage: hpBefore - ship.hp, x, y });
  }
  return killed;
}

function consumePickup(holder, ship, world) {
  if (ship.destroyed) return;
  ship.applyPickup(holder.pickup.effect, holder.pickup.duration);
  world.despawn(holder.id);
  world.emit('pickup', {
    shipId: ship.id,
    effect: holder.pickup.effect,
    x: ship.pos.x,
    y: ship.pos.y,
  });
}

// Collision handler: dispatch on the PAIR of kinds. Pairs arrive in arbitrary order,
// so normalize them: handlers receive (a, b) with a.kind <= b.kind alphabetically.
const handlers = {
  'asteroid|asteroid': (a, b) => bounceApart(a, b, 0.9),

  'asteroid|bullet': (asteroid, bullet, world) => {
    world.despawn(bullet.id);
    if (asteroid.damage(bullet.damage)) {
      destroyAsteroid(world, asteroid, world.get(bullet.ownerId));
    } else {
      world.emit('hit', { kind: 'asteroid', id: asteroid.id, x: bullet.pos.x, y: bullet.pos.y });
    }
  },

  'asteroid|ship': (asteroid, ship, world) => {
    const impact = bounceApart(asteroid, ship, 0.6);
    if (ship.shielded) return;
    const dmg = Math.round(10 + asteroid.size * 8 + impact * 0.05);
    damageShip(world, ship, dmg);
  },

  'bullet|ship': (bullet, ship, world) => {
    if (bullet.ownerId === ship.id) return; // can't shoot yourself
    world.despawn(bullet.id);
    if (damageShip(world, ship, bullet.damage)) {
      const shooter = world.get(bullet.ownerId);
      if (shooter) {
        shooter.score += 100;
        const { x, y } = ship.pos;
        world.emit('scored', { shipId: shooter.id, points: 100, total: shooter.score, x, y });
      }
    }
  },
};

function onCollision(a, b, world) {
  // Component-based rule first: anything carrying a `pickup` component is consumed by a ship,
  // whatever its class or kind is.
  if (a.kind === 'ship' && b.pickup) return consumePickup(b, a, world);
  if (b.kind === 'ship' && a.pickup) return consumePickup(a, b, world);
  if (a.pickup || b.pickup) return; // pickups ignore bullets and rocks

  const [x, y] = a.kind <= b.kind ? [a, b] : [b, a];
  const handler = handlers[`${x.kind}|${y.kind}`];
  if (handler) handler(x, y, world);
}
