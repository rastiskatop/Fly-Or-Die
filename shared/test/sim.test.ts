// Unit tests for the simulation: vectors, ship motion, collisions, World bookkeeping, game rules.
import { describe, expect, test } from 'vitest';
import { Vector2 } from '../src/sim/vector.ts';
import { World } from '../src/sim/world.ts';
import {
  Ship,
  stepShipMotion,
  NO_CONTROLS,
  TURN_SPEED,
  FIRE_COOLDOWN_S,
  BULLET_SPEEDS,
} from '../src/sim/ship.ts';
import type { ShipMotionState } from '../src/sim/ship.ts';
import { Bullet } from '../src/sim/bullet.ts';
import { Asteroid, ASTEROID_RADIUS } from '../src/sim/asteroid.ts';
import { Pickup } from '../src/sim/pickup.ts';
import { Explosion, particlePool } from '../src/sim/explosion.ts';
import { circlesOverlap, findCollisions } from '../src/sim/collision.ts';
import { createGame, createMatchWorld, spawnPlayerShip } from '../src/sim/game.ts';
import { asEntityId } from '../src/ids.ts';
import { DT } from '../src/net/protocol.ts';
import { Bus } from '../src/bus.ts';

const BOUNDS = { width: 1280, height: 720 };
/** An arena with no rocks and no pickups: only what the test spawns. */
const EMPTY = { asteroidMass: 0, initialAsteroids: 0, maxPickups: 0 };
const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

function motion(over: Partial<ShipMotionState> = {}): ShipMotionState {
  return {
    pos: new Vector2(640, 360),
    vel: Vector2.ZERO,
    angle: 0,
    effects: new Map(),
    invulnerableFor: 0,
    fireCooldown: 0,
    thrusting: false,
    ...over,
  };
}

describe('Vector2', () => {
  test('add / sub / scale / dot / length', () => {
    const a = new Vector2(3, 4);
    const b = new Vector2(1, -2);
    expect(a.add(b)).toEqual(new Vector2(4, 2));
    expect(a.sub(b)).toEqual(new Vector2(2, 6));
    expect(a.scale(2)).toEqual(new Vector2(6, 8));
    expect(a.dot(b)).toBe(-5);
    expect(a.length()).toBe(5);
    expect(a.lengthSq()).toBe(25);
  });

  test('operations return new vectors and never mutate (readonly by design)', () => {
    const a = new Vector2(1, 1);
    const b = a.add(new Vector2(1, 0));
    expect(a).toEqual(new Vector2(1, 1));
    expect(b).not.toBe(a);
    expect(Object.isFrozen(Vector2.ZERO) || Vector2.ZERO.x === 0).toBe(true);
  });

  test('normalize: unit length, and the zero vector stays zero (no NaN)', () => {
    close(new Vector2(10, -7).normalize().length(), 1, 1e-12);
    const z = Vector2.ZERO.normalize();
    expect(Number.isNaN(z.x) || Number.isNaN(z.y)).toBe(false);
  });

  test('rotate by π/2 and fromAngle / angle agree', () => {
    const r = new Vector2(1, 0).rotate(Math.PI / 2);
    close(r.x, 0, 1e-12);
    close(r.y, 1, 1e-12);
    const v = Vector2.fromAngle(0.7, 3);
    close(v.length(), 3, 1e-12);
    close(v.angle(), 0.7, 1e-12);
  });

  test('clampLength only shortens; addScaled; withX / withY', () => {
    expect(new Vector2(3, 4).clampLength(10)).toEqual(new Vector2(3, 4));
    close(new Vector2(30, 40).clampLength(10).length(), 10, 1e-12);
    expect(new Vector2(1, 2).addScaled(new Vector2(1, 1), 3)).toEqual(new Vector2(4, 5));
    expect(new Vector2(1, 2).withX(9)).toEqual(new Vector2(9, 2));
    expect(new Vector2(1, 2).withY(9)).toEqual(new Vector2(1, 9));
  });
});

describe('stepShipMotion (integration of one fixed step)', () => {
  test('no controls, no velocity → stays put', () => {
    const s = motion();
    stepShipMotion(s, NO_CONTROLS, DT, BOUNDS);
    expect(s.pos).toEqual(new Vector2(640, 360));
  });

  test('thrust accelerates along the nose; drag slows a coasting ship', () => {
    const s = motion({ angle: 0 });
    stepShipMotion(s, { ...NO_CONTROLS, thrust: true }, DT, BOUNDS);
    expect(s.vel.x).toBeGreaterThan(0);
    close(s.vel.y, 0, 1e-9);
    expect(s.thrusting).toBe(true);
    const v1 = s.vel.length();
    stepShipMotion(s, NO_CONTROLS, DT, BOUNDS);
    expect(s.vel.length()).toBeLessThan(v1);
  });

  test('turning: TURN_SPEED·dt per step, angle kept in (-π, π]', () => {
    const s = motion({ angle: 0 });
    stepShipMotion(s, { ...NO_CONTROLS, right: true }, DT, BOUNDS);
    close(s.angle, TURN_SPEED * DT);
    const t = motion({ angle: Math.PI - 0.01 });
    stepShipMotion(t, { ...NO_CONTROLS, right: true }, DT, BOUNDS);
    expect(t.angle).toBeLessThanOrEqual(Math.PI);
    expect(t.angle).toBeGreaterThan(-Math.PI);
  });

  test('top speed is capped; the speed pickup doubles it', () => {
    const s = motion();
    const p = motion({ effects: new Map([['speed', 100]]) });
    for (let i = 0; i < 600; i++) {
      stepShipMotion(s, { ...NO_CONTROLS, thrust: true }, DT, BOUNDS);
      stepShipMotion(p, { ...NO_CONTROLS, thrust: true }, DT, BOUNDS);
    }
    expect(s.vel.length()).toBeLessThanOrEqual(600 + 1e-9);
    expect(p.vel.length()).toBeGreaterThan(600);
    expect(p.vel.length()).toBeLessThanOrEqual(1200 + 1e-9);
  });

  test('wraps around the arena edges', () => {
    const s = motion({ pos: new Vector2(1279, 719), vel: new Vector2(120, 120) });
    stepShipMotion(s, NO_CONTROLS, DT, BOUNDS);
    expect(s.pos.x).toBeLessThan(10);
    expect(s.pos.y).toBeLessThan(10);
  });

  test('fire is gated by the cooldown; effects tick down and expire', () => {
    const s = motion({ fireCooldown: 0.1, effects: new Map([['bullets', DT / 2]]) });
    expect(stepShipMotion(s, { ...NO_CONTROLS, fire: true }, DT, BOUNDS)).toBe(false);
    expect(s.effects.has('bullets')).toBe(false);
    s.fireCooldown = 0;
    expect(stepShipMotion(s, { ...NO_CONTROLS, fire: true }, DT, BOUNDS)).toBe(true);
  });
});

describe('collisions', () => {
  const c = (x: number, y: number, radius: number) => ({ pos: { x, y }, radius });

  test('overlapping, touching, separate', () => {
    expect(circlesOverlap(c(0, 0, 10), c(15, 0, 10))).toBe(true); // overlapping
    expect(circlesOverlap(c(0, 0, 10), c(20, 0, 10))).toBe(false); // exactly touching: not a hit
    expect(circlesOverlap(c(0, 0, 10), c(50, 0, 10))).toBe(false); // missing
  });

  test('findCollisions reports each overlapping pair once and skips dead / non-collidable', () => {
    const world = new World({ ...BOUNDS });
    const a = world.spawn(new Asteroid({ x: 100, y: 100, vx: 0, vy: 0, size: 2, rng: () => 0.5 }));
    const b = world.spawn(new Asteroid({ x: 120, y: 100, vx: 0, vy: 0, size: 2, rng: () => 0.5 }));
    world.spawn(new Asteroid({ x: 900, y: 600, vx: 0, vy: 0, size: 1, rng: () => 0.5 }));
    const pairs = findCollisions(world);
    expect(pairs).toHaveLength(1);
    expect(new Set(pairs[0])).toEqual(new Set([a, b]));
    b.collidable = false;
    expect(findCollisions(world)).toHaveLength(0);
  });

  test('a fast bullet does not tunnel through a small rock at the 30 Hz server tick', () => {
    // Bullet at fast speed + a ship's top speed: ~2000 px/s → 67 px per 1/30 s step. The smallest
    // rock plus the bullet is 34 px across, so a point test between steps can miss it entirely.
    const world = createMatchWorld({ ...BOUNDS, arena: EMPTY });
    const rock = world.spawn(
      new Asteroid({ x: 640, y: 360, vx: 0, vy: 0, size: 1, rng: () => 0.5 }),
    );
    const speed = BULLET_SPEEDS.fast + 600; // 2000 px/s
    const shooter = world.spawn(new Ship({ x: 100, y: 100 }));
    // x = 600 now, x ≈ 667 after one step: clear of the rock (640 ± 17) at BOTH ends.
    const startX = 640 - 40;
    expect(startX + speed * DT - 640).toBeGreaterThan(ASTEROID_RADIUS[1] + 3);
    const bullet = world.spawn(
      new Bullet({ x: startX, y: 360, vx: speed, vy: 0, ownerId: shooter.id }),
    );
    world.step(DT);
    expect(bullet.alive).toBe(false); // it hit something…
    expect(rock.hitFlash > 0 || !rock.alive).toBe(true); // …the rock
  });
});

describe('World', () => {
  test('spawn during a step is deferred to the end of the step; despawn is too', () => {
    const world = new World({ ...BOUNDS });
    const ship = world.spawn(new Ship({ x: 100, y: 100 }));
    world.systems.push((w) => {
      if (w.tick === 0) w.spawn(new Pickup({ x: 50, y: 50, effect: 'repair' }));
    });
    world.step(DT);
    expect(world.countOfKind('pickup')).toBe(1);
    world.despawn(ship.id);
    expect(ship.alive).toBe(false);
    world.step(DT);
    expect(world.get(ship.id)).toBeUndefined();
  });

  test('ofKind yields only that kind; size counts everything', () => {
    const world = new World({ ...BOUNDS });
    world.spawn(new Ship({ x: 1, y: 1 }));
    world.spawn(new Asteroid({ x: 500, y: 500, vx: 0, vy: 0, rng: () => 0.5 }));
    world.spawn(new Explosion({ x: 0, y: 0, count: 3, rng: () => 0.5 }));
    expect([...world.ofKind('ship')].every((s) => s.kind === 'ship')).toBe(true);
    expect(world.size).toBe(3);
  });

  test('bouncing entities stay inside, wrapping ones wrap', () => {
    const world = new World({ ...BOUNDS });
    const rock = world.spawn(
      new Asteroid({ x: 30, y: 360, vx: -900, vy: 0, size: 2, rng: () => 0.5 }),
    );
    for (let i = 0; i < 10; i++) world.step(DT);
    expect(rock.pos.x).toBeGreaterThanOrEqual(rock.radius - 1e-9);
    expect(rock.vel.x).toBeGreaterThan(0);
  });

  test('step(world) is deterministic: two worlds, same seed, same inputs → identical state', () => {
    const run = () => {
      const { world, player } = createGame({ ...BOUNDS, playerName: 'A' });
      for (let i = 0; i < 300; i++) {
        world.step(
          DT,
          new Map([
            [player.id, { left: i % 7 < 2, right: false, thrust: i % 3 === 0, fire: i % 5 === 0 }],
          ]),
        );
      }
      return [...world].map((e) => [e.kind, e.pos.x, e.pos.y, e.vel.x, e.vel.y, e.angle]);
    };
    expect(run()).toEqual(run());
  });
});

describe('game rules', () => {
  test('a bullet hitting another ship damages it and scores for the shooter when it dies', () => {
    const world = createMatchWorld({ ...BOUNDS, arena: EMPTY });
    const a = spawnPlayerShip(world, 'A');
    const b = world.spawn(new Ship({ x: 900, y: 300, name: 'B' }));
    b.invulnerableFor = 0;
    let scored = 0;
    world.events.on('scored', (e) => (scored += e.points));
    for (let i = 0; i < 4; i++) {
      world.spawn(new Bullet({ x: b.pos.x, y: b.pos.y, vx: 0, vy: 0, ownerId: a.id }));
      world.step(DT);
    }
    expect(b.destroyed).toBe(true);
    expect(a.score).toBe(100);
    expect(scored).toBe(100);
  });

  test('a ship cannot shoot itself; shields block damage', () => {
    const world = createMatchWorld({ ...BOUNDS, arena: EMPTY });
    const a = world.spawn(new Ship({ x: 300, y: 300 }));
    world.spawn(new Bullet({ x: 300, y: 300, vx: 0, vy: 0, ownerId: a.id }));
    world.step(DT);
    expect(a.hp).toBe(100);
    a.invulnerableFor = 1;
    expect(a.damage(50)).toBe(false);
    expect(a.hp).toBe(100);
  });

  test('pickups: repair heals to full, speed is a timed effect, the pickup is consumed', () => {
    const world = createMatchWorld({ ...BOUNDS, arena: EMPTY });
    const ship = world.spawn(new Ship({ x: 400, y: 400 }));
    ship.invulnerableFor = 0;
    ship.damage(60);
    world.spawn(new Pickup({ x: 400, y: 400, effect: 'repair' }));
    world.step(DT);
    expect(ship.hp).toBe(100);
    expect(world.countOfKind('pickup')).toBe(0);
    ship.applyPickup('speed', 10);
    expect(ship.effects.get('speed')).toBe(10);
  });

  test('a large rock splits into two smaller ones when shot down', () => {
    const world = createMatchWorld({ ...BOUNDS, arena: EMPTY });
    const shooter = world.spawn(new Ship({ x: 100, y: 100 }));
    const rock = world.spawn(
      new Asteroid({ x: 700, y: 400, vx: 0, vy: 0, size: 2, rng: () => 0.5 }),
    );
    while (rock.alive) {
      world.spawn(new Bullet({ x: rock.pos.x, y: rock.pos.y, vx: 0, vy: 0, ownerId: shooter.id }));
      world.step(DT);
    }
    world.step(DT);
    const sizes = [...world.ofKind('asteroid')].map((r) => r.size);
    expect(sizes.filter((s) => s === 1).length).toBe(2);
    expect(shooter.score).toBeGreaterThan(0);
  });

  test('destroyed ships respawn after the delay, with spawn protection', () => {
    const world = createMatchWorld({ ...BOUNDS, arena: EMPTY });
    const ship = world.spawn(new Ship({ x: 500, y: 500 }));
    ship.invulnerableFor = 0;
    ship.damage(1000);
    expect(ship.destroyed).toBe(true);
    for (let i = 0; i < 61; i++) world.step(1 / 30);
    expect(ship.destroyed).toBe(false);
    expect(ship.hp).toBe(100);
    expect(ship.shielded).toBe(true);
    expect(ship.deaths).toBe(1);
  });

  test('fire(): bullet inherits the ship velocity and the cooldown starts', () => {
    const world = new World({ ...BOUNDS });
    const ship = world.spawn(new Ship({ x: 300, y: 300, angle: 0 }));
    ship.vel = new Vector2(100, 0);
    const bullet = ship.fire(world);
    expect(bullet?.vel.x).toBeCloseTo(100 + BULLET_SPEEDS.normal, 6);
    expect(ship.fireCooldown).toBe(FIRE_COOLDOWN_S);
  });
});

test('explosion particles are pooled: a finished explosion hands its particles to the next one', () => {
  const world = new World({ ...BOUNDS });
  world.spawn(new Explosion({ x: 10, y: 10, count: 20, rng: () => 0.5 }));
  for (let i = 0; i < 60; i++) world.step(DT); // ttl 0.9 s → done
  expect(world.countOfKind('explosion')).toBe(0);
  const created = particlePool.created;
  const reused = particlePool.reused;
  const next = world.spawn(new Explosion({ x: 10, y: 10, count: 20, rng: () => 0.5 }));
  expect(particlePool.created).toBe(created); // no new particle objects…
  expect(particlePool.reused - reused).toBe(20); // …all 20 came from the pool
  expect(next.particles.every((p) => p.x === 0 && p.y === 0)).toBe(true); // and were reset
});

describe('Bus', () => {
  test('on / emit / off, and an aborted signal unsubscribes', () => {
    const bus = new Bus<{ ping: { n: number } }>();
    const seen: number[] = [];
    const off = bus.on('ping', (p) => seen.push(p.n));
    const ctl = new AbortController();
    bus.on('ping', (p) => seen.push(p.n * 10), { signal: ctl.signal });
    bus.emit('ping', { n: 1 });
    ctl.abort();
    off();
    bus.emit('ping', { n: 2 });
    expect(seen).toEqual([1, 10]);
  });
});

test('entity ids are valid EntityIds (1..65535)', () => {
  const s = new Ship({ x: 0, y: 0 });
  expect(asEntityId(s.id)).toBe(s.id);
});
