// Immutable-by-default 2D vector.
// Pure methods (add, sub, scale, ...) always return a NEW Vector2 and never touch `this`.
// The *InPlace variants exist for hot paths (entity integration runs every step for every entity).
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static zero() {
    return new Vector2(0, 0);
  }

  clone() {
    return new Vector2(this.x, this.y);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  length() {
    return Math.sqrt(this.lengthSq());
  }

  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  angle() {
    return Math.atan2(this.y, this.x);
  }

  // --- in-place variants (mutate and return `this` for chaining) ---

  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  copyFrom(v) {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  addInPlace(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  addScaledInPlace(v, k) {
    this.x += v.x * k;
    this.y += v.y * k;
    return this;
  }

  scaleInPlace(k) {
    this.x *= k;
    this.y *= k;
    return this;
  }

  clampLengthInPlace(max) {
    const lenSq = this.lengthSq();
    if (lenSq > max * max) {
      const k = max / Math.sqrt(lenSq);
      this.x *= k;
      this.y *= k;
    }
    return this;
  }
}
