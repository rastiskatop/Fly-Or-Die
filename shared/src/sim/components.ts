// Components = small pieces of data attached to ANY entity as a field.
// Systems = functions that run over every entity that has the component.
// Neither knows nor cares about the entity's class: a Bullet and an Asteroid
// both become "homing" by getting `e.homing = homing(...)`.
import type { EntityId } from '../ids.ts';
import type { EntityKind } from './entity.ts';
import type { AnyEntity, World } from './world.ts';

export interface Homing {
  readonly targetKinds: readonly EntityKind[];
  readonly turnRate: number;
  readonly range: number;
  targetId: EntityId | null;
}

/** Factory for the homing component. Plain data — easy to serialize. */
export function homing({
  targetKinds,
  turnRate = 2,
  range = 400,
}: {
  targetKinds: readonly EntityKind[];
  turnRate?: number;
  range?: number;
}): Homing {
  return { targetKinds, turnRate, range, targetId: null };
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function isValidTarget(e: AnyEntity): boolean {
  return e.alive && e.collidable && !(e.kind === 'ship' && e.destroyed);
}

/** Steers every entity that has a `homing` component toward the nearest target. */
export function homingSystem(world: World, dt: number): void {
  for (const e of world) {
    const h = e.homing;
    if (!h || !e.alive) continue;

    let target = h.targetId !== null ? world.get(h.targetId) : undefined;
    if (!target || !isValidTarget(target)) {
      target = undefined;
      let bestSq = h.range * h.range;
      for (const kind of h.targetKinds) {
        for (const t of world.ofKind(kind)) {
          if (t === e || !isValidTarget(t)) continue;
          const dSq = t.pos.sub(e.pos).lengthSq();
          if (dSq < bestSq) {
            bestSq = dSq;
            target = t;
          }
        }
      }
      h.targetId = target ? target.id : null;
    }
    if (!target) continue;

    // Turn the velocity vector toward the target, keeping its length (speed).
    const desired = target.pos.sub(e.pos).angle();
    const current = e.vel.angle();
    const diff = wrapAngle(desired - current);
    const maxTurn = h.turnRate * dt;
    const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
    e.vel = e.vel.rotate(turn);
  }
}
