// Percentiles for benchmarks and live stats (Lab 7): median and tail, never just the mean.

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/** Nearest-rank percentiles. The input is copied and sorted, never modified. */
export function summarize(samples: ArrayLike<number>): Summary {
  const s = Float64Array.from(samples).sort();
  const n = s.length;
  if (n === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const at = (p: number): number => s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))] ?? 0;
  let sum = 0;
  for (const v of s) sum += v;
  return { n, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[n - 1] ?? 0, mean: sum / n };
}

/** A fixed-size ring of samples: push never allocates, the oldest samples fall off. */
export class SampleRing {
  readonly #data: Float64Array;
  #n = 0;
  constructor(capacity: number) {
    this.#data = new Float64Array(capacity);
  }
  push(v: number): void {
    this.#data[this.#n % this.#data.length] = v;
    this.#n++;
  }
  /** The samples currently held (a copy). */
  values(): Float64Array {
    return this.#data.slice(0, Math.min(this.#n, this.#data.length));
  }
  get size(): number {
    return Math.min(this.#n, this.#data.length);
  }
  clear(): void {
    this.#n = 0;
  }
}
