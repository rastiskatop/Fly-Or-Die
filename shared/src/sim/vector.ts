import { dsin, dcos, datan2 } from './dmath.ts';

/**
 * Immutable 2D vector: `readonly x, y`, every operation returns a new Vector2.
 * Lab 2 made "pure methods, never mutate" a convention; TypeScript makes it a rule —
 * `v.x = 1` is a compile error. (The Lab 2 *InPlace helpers are gone; entities now replace
 * their `pos`/`vel` instead of mutating them, with exactly the same arithmetic.)
 */
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static readonly ZERO = new Vector2(0, 0);

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(dcos(angle) * length, dsin(angle) * length);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  /** this + v·k (one rounding per component, same as the old addScaledInPlace). */
  addScaled(v: Vector2, k: number): Vector2 {
    return new Vector2(this.x + v.x * k, this.y + v.y * k);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? Vector2.ZERO : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle: number): Vector2 {
    const c = dcos(angle);
    const s = dsin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  clampLength(max: number): Vector2 {
    const lenSq = this.lengthSq();
    if (lenSq <= max * max) return this;
    const k = max / Math.sqrt(lenSq);
    return new Vector2(this.x * k, this.y * k);
  }

  angle(): number {
    return datan2(this.y, this.x);
  }

  withX(x: number): Vector2 {
    return new Vector2(x, this.y);
  }

  withY(y: number): Vector2 {
    return new Vector2(this.x, y);
  }
}
