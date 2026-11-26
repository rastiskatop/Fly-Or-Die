import { Entity } from './entity.js';

export class Bullet extends Entity {
  constructor({ x, y, vx, vy, ownerId, ttl = 1.2, damage = 25 }) {
    super({ kind: 'bullet', x, y, vx, vy, angle: Math.atan2(vy, vx), radius: 3 });
    this.ownerId = ownerId;
    this.ttl = ttl; // time-to-live, seconds
    this.damage = damage;
  }

  update(dt, world) {
    super.update(dt, world);
    this.angle = Math.atan2(this.vel.y, this.vel.x);
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
