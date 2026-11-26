// Token bucket: the bucket holds up to `burst` tokens and refills at `ratePerSec`.
// Every message costs one token; an empty bucket means "too fast".
// Allows short bursts (typing quickly) but caps the sustained rate.
export class TokenBucket {
  #tokens: number;
  #last: number;
  readonly ratePerSec: number;
  readonly burst: number;

  constructor({
    ratePerSec,
    burst,
    now = Date.now(),
  }: {
    ratePerSec: number;
    burst: number;
    now?: number;
  }) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.#tokens = burst;
    this.#last = now;
  }

  take(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.#last) / 1000;
    this.#last = now;
    this.#tokens = Math.min(this.burst, this.#tokens + elapsed * this.ratePerSec);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  get tokens(): number {
    return this.#tokens;
  }
}
