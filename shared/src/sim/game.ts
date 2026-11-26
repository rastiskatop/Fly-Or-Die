// Game rules: what a collision MEANS, and who spawns what. The World itself stays generic.
import { World, type AnyEntity } from './world.ts';
import { Ship } from './ship.ts';
import { Asteroid, ASTEROID_SCORE, type AsteroidSize } from './asteroid.ts';
import { Explosion } from './explosion.ts';
import { Pickup, PICKUP_EFFECTS } from './pickup.ts';
import type { Bullet } from './bullet.ts';
import { Vector2 } from './vector.ts';
import { homing } from './components.ts';
import { ArenaSchema, DEFAULT_ARENA, type ArenaRules } from './arena.ts';

export { DEFAULT_ARENA };

const PICKUP_DROP_CHANCE = 0.12;

/** A world with the arena's rules and asteroids, but no players yet (the server's Match). */
export function createMatchWorld({
  width,
  height,
  arena = DEFAULT_ARENA,
}: {
  width: number;
  height: number;
  arena?: Partial<ArenaRules>;
}): World {
  const rules = ArenaSchema.parse({ ...DEFAULT_ARENA, ...arena });
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
export function spawnPlayerShip(world: World, name: string): Ship {
  const spot =
    world.size > 0 ? world.findSafeSpot(150) : { x: world.width / 2, y: world.height / 2 };
  return world.spawn(new Ship({ x: spot.x, y: spot.y, name }));
}

/** Offline / single-player game (Labs 1–4): a match world with one local player. */
export function createGame({
  width,
  height,
  arena = DEFAULT_ARENA,
  playerName = 'P1',
}: {
  width: number;
  height: number;
  arena?: Partial<ArenaRules>;
  playerName?: string;
}): { world: World; player: Ship } {
  const world = createMatchWorld({ width, height, arena });
  const player = world.spawn(new Ship({ x: width / 2, y: height / 2, name: playerName }));
  return { world, player };
}

function spawnRandomPickup(world: World, at?: Vector2): void {
  const p = at ?? world.findSafeSpot(60);
  const effect = PICKUP_EFFECTS[Math.floor(world.rng() * PICKUP_EFFECTS.length)] ?? 'repair';
  world.spawn(new Pickup({ x: p.x, y: p.y, effect }));
}

function spawnAsteroidAtEdge(world: World): Asteroid {
  const { rng, width: w, height: h } = world;
  const side = Math.floor(rng() * 4);
  const r = 44;
  const x = side === 0 ? r : side === 1 ? w - r : r + rng() * (w - 2 * r);
  const y = side === 2 ? r : side === 3 ? h - r : r + rng() * (h - 2 * r);
  // Aim roughly at the centre so it drifts across the arena.
  const toCenter = new Vector2(w / 2 - x, h / 2 - y).normalize().rotate((rng() - 0.5) * 1.2);
  const v = toCenter.scale(40 + rng() * 50);
  return world.spawn(new Asteroid({ x, y, vx: v.x, vy: v.y, size: 3, rng }));
}

function explode(world: World, e: AnyEntity, color: string, count: number): void {
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

function destroyAsteroid(world: World, asteroid: Asteroid, killer: Ship | null): void {
  world.despawn(asteroid.id);
  explode(world, asteroid, '#c8b49a', 10 + asteroid.size * 8);
  const { x, y } = asteroid.pos;
  world.emit('exploded', { kind: 'asteroid', size: asteroid.size, x, y });
  if (killer) {
    const points = ASTEROID_SCORE[asteroid.size];
    killer.score += points;
    world.emit('scored', { shipId: killer.id, points, x, y });
  }

  if (asteroid.size > 1) {
    const childSize: AsteroidSize = asteroid.size === 3 ? 2 : 1;
    for (const sign of [-1, 1]) {
      const v = asteroid.vel.rotate(sign * (0.5 + world.rng() * 0.4)).scale(1.4);
      const offset = Vector2.fromAngle(v.angle() + (sign * Math.PI) / 2, asteroid.radius * 0.4);
      const child = new Asteroid({
        x: asteroid.pos.x + offset.x,
        y: asteroid.pos.y + offset.y,
        vx: v.x,
        vy: v.y,
        size: childSize,
        rng: world.rng,
      });
      // Composition: some fragments become seekers by GETTING a component, not a new subclass.
      if (child.size === 2 && world.rng() < world.rules.seekerChance) {
        child.homing = homing({ targetKinds: ['ship'], turnRate: 0.7, range: 600 });
      }
      world.spawn(child);
    }
  } else if (world.rng() < PICKUP_DROP_CHANCE) {
    spawnRandomPickup(world, asteroid.pos);
  }
}

/** Elastic-ish bounce. Same arithmetic as the mutable Lab 2 version, written immutably. */
function bounceApart(a: AnyEntity, b: AnyEntity, restitution = 1): number {
  const n = b.pos.sub(a.pos);
  const dist = n.length() || 1;
  const nx = n.x / dist;
  const ny = n.y / dist;
  const ma = a.mass;
  const mb = b.mass;

  // Positional correction: push out of overlap proportionally to mass.
  const overlap = a.radius + b.radius - dist;
  if (overlap > 0) {
    const total = ma + mb;
    a.pos = new Vector2(
      a.pos.x - nx * overlap * (mb / total),
      a.pos.y - ny * overlap * (mb / total),
    );
    b.pos = new Vector2(
      b.pos.x + nx * overlap * (ma / total),
      b.pos.y + ny * overlap * (ma / total),
    );
  }

  // Impulse along the normal (only if they're moving toward each other).
  const rel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
  if (rel >= 0) return 0;
  const j = (-(1 + restitution) * rel) / (1 / ma + 1 / mb);
  a.vel = new Vector2(a.vel.x - (j / ma) * nx, a.vel.y - (j / ma) * ny);
  b.vel = new Vector2(b.vel.x + (j / mb) * nx, b.vel.y + (j / mb) * ny);
  return -rel; // impact speed
}

/** @returns true if the ship was destroyed */
function damageShip(world: World, ship: Ship, amount: number): boolean {
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

function consumePickup(holder: AnyEntity, ship: Ship, world: World): void {
  const pickup = holder.pickup;
  if (ship.destroyed || !pickup) return;
  ship.applyPickup(pickup.effect, pickup.duration);
  world.despawn(holder.id);
  world.emit('pickup', { shipId: ship.id, effect: pickup.effect, x: ship.pos.x, y: ship.pos.y });
}

/** The shooter of a bullet — if its owner id still points at a ship. (Ids wrap at 65535!) */
function shooterOf(world: World, bullet: Bullet): Ship | null {
  const owner = world.get(bullet.ownerId);
  return owner?.kind === 'ship' ? owner : null;
}

function onCollision(a: AnyEntity, b: AnyEntity, world: World): void {
  // Component-based rule first: anything carrying a `pickup` component is consumed by a ship.
  if (a.kind === 'ship' && b.pickup) return consumePickup(b, a, world);
  if (b.kind === 'ship' && a.pickup) return consumePickup(a, b, world);
  if (a.pickup || b.pickup) return; // pickups ignore bullets and rocks

  // Pairs arrive in arbitrary order: normalize so x.kind <= y.kind alphabetically.
  const [x, y] = a.kind <= b.kind ? [a, b] : [b, a];

  if (x.kind === 'asteroid' && y.kind === 'asteroid') {
    bounceApart(x, y, 0.9);
  } else if (x.kind === 'asteroid' && y.kind === 'bullet') {
    world.despawn(y.id);
    if (x.damage(y.damage)) destroyAsteroid(world, x, shooterOf(world, y));
    else world.emit('hit', { kind: 'asteroid', id: x.id, x: y.pos.x, y: y.pos.y });
  } else if (x.kind === 'asteroid' && y.kind === 'ship') {
    const impact = bounceApart(x, y, 0.6);
    if (y.shielded) return;
    damageShip(world, y, Math.round(10 + x.size * 8 + impact * 0.05));
  } else if (x.kind === 'bullet' && y.kind === 'ship') {
    if (x.ownerId === y.id) return; // can't shoot yourself
    world.despawn(x.id);
    if (damageShip(world, y, x.damage)) {
      const shooter = shooterOf(world, x);
      if (shooter) {
        shooter.score += 100;
        world.emit('scored', { shipId: shooter.id, points: 100, x: y.pos.x, y: y.pos.y });
      }
    }
  }
  // other pairs (bullet|bullet, ship|ship, …) don't interact
}
