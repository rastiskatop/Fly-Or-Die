import { datan2 } from './dmath.ts';
import { Entity } from './entity.ts';
import type { World } from './world.ts';
import type { EntityId, Seq } from '../ids.ts';
import { asSeq } from '../ids.ts';

export class Bullet extends Entity<'bullet'> {
  readonly ownerId: EntityId;
  ttl: number; // time-to-live, seconds
  readonly damage: number;
  fast = false;
  /** The shooter's input seq (Lab 5: matches the client's predicted bullet). */
  spawnSeq: Seq = asSeq(0);

  constructor({
    x,
    y,
    vx,
    vy,
    ownerId,
    ttl = 1.2,
    damage = 25,
  }: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    ownerId: EntityId;
    ttl?: number;
    damage?: number;
  }) {
    super('bullet', { x, y, vx, vy, angle: datan2(vy, vx), radius: 3 });
    this.ownerId = ownerId;
    this.ttl = ttl;
    this.damage = damage;
  }

  override update(dt: number, world: World): void {
    super.update(dt, world);
    this.angle = datan2(this.vel.y, this.vel.x);
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
