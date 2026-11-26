// Heartbeat and token bucket with fake time: minutes of protocol behaviour in milliseconds.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startHeartbeat, type Pingable } from '../src/heartbeat.ts';
import { TokenBucket } from '../src/rate-limit.ts';

class FakeSocket implements Pingable {
  pings = 0;
  terminated = false;
  state = { missedPongs: 0 };
  readonly answers: boolean;
  constructor(answers: boolean) {
    this.answers = answers; // no parameter property: erasableSyntaxOnly (Node strips types only)
  }
  ping(): void {
    this.pings++;
    if (this.answers) queueMicrotask(() => (this.state.missedPongs = 0)); // the pong handler
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('a live socket is pinged every interval and never terminated', async () => {
    const live = new FakeSocket(true);
    const stop = startHeartbeat({
      intervalMs: 1000,
      sockets: () => [live],
      stateOf: (s) => s.state,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    expect(live.pings).toBe(10);
    expect(live.terminated).toBe(false);
  });

  test('a dead socket is terminated on the third beat (two missed pongs)', async () => {
    const dead = new FakeSocket(false);
    const died: FakeSocket[] = [];
    const stop = startHeartbeat({
      intervalMs: 1000,
      sockets: () => [dead],
      stateOf: (s) => s.state,
      onDead: (s) => died.push(s),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(dead.terminated).toBe(false);
    expect(dead.pings).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dead.terminated).toBe(true);
    expect(died).toEqual([dead]);
    stop();
  });

  test('untracked sockets are skipped; stop() stops it', async () => {
    const s = new FakeSocket(false);
    const stop = startHeartbeat({ intervalMs: 500, sockets: () => [s], stateOf: () => undefined });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.pings).toBe(0);
    stop();
    const t = new FakeSocket(true);
    const stop2 = startHeartbeat({ intervalMs: 500, sockets: () => [t], stateOf: (x) => x.state });
    stop2();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.pings).toBe(0);
  });
});

describe('token bucket', () => {
  test('burst, then exactly the sustained rate', () => {
    const b = new TokenBucket({ ratePerSec: 10, burst: 20, now: 0 });
    let ok = 0;
    for (let i = 0; i < 25; i++) if (b.take(0)) ok++;
    expect(ok).toBe(20);
    // One second later: 10 more tokens, no more.
    ok = 0;
    for (let i = 0; i < 15; i++) if (b.take(1000)) ok++;
    expect(ok).toBe(10);
  });

  test('never refills above the burst; a clock going backwards adds nothing', () => {
    const b = new TokenBucket({ ratePerSec: 5, burst: 3, now: 0 });
    b.take(60_000);
    expect(b.tokens).toBeLessThanOrEqual(3);
    const c = new TokenBucket({ ratePerSec: 5, burst: 1, now: 1000 });
    expect(c.take(1000)).toBe(true);
    expect(c.take(500)).toBe(false); // time went backwards: no free tokens
  });
});
