import { datan2 } from './dmath.js';
import { Entity } from './entity.js';

export class Bullet extends Entity {
  constructor({ x, y, vx, vy, ownerId, ttl = 1.2, damage = 25 }) {
    super({ kind: 'bullet', x, y, vx, vy, angle: datan2(vy, vx), radius: 3 });
    this.ownerId = ownerId;
    this.ttl = ttl; // time-to-live, seconds
    this.damage = damage;
    this.fast = false;
    this.spawnSeq = 0; // the shooter's input seq (Lab 5: matches the client's predicted bullet)
  }

  update(dt, world) {
    super.update(dt, world);
    this.angle = datan2(this.vel.y, this.vel.x);
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
