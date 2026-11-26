// The Lab 1 fixed-timestep loop under fake timers: no waiting, exact control of time.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLoop } from '../src/loop.ts';

/** How long until the next rAF fires — 60 Hz, unless a test simulates a stalled tab. */
let frameMs = 1000 / 60;

describe('createLoop (accumulator)', () => {
  beforeEach(() => {
    frameMs = 1000 / 60;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    // Node has no rAF: a display driven by the fake clock.
    let next = 0;
    const handles = new Map<number, ReturnType<typeof setTimeout>>();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++next;
      handles.set(
        id,
        setTimeout(() => cb(performance.now()), frameMs),
      );
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(handles.get(id)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('60 simulation steps per simulated second, whatever the frame rate', () => {
    let steps = 0;
    const loop = createLoop({ step: 1 / 60, simulate: () => steps++, render: () => {} });
    loop.start();
    vi.advanceTimersByTime(1000);
    loop.stop();
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(60);
  });

  test('a 30 Hz step runs every other frame; alpha stays in [0, 1)', () => {
    let steps = 0;
    const alphas: number[] = [];
    const loop = createLoop({
      step: 1 / 30,
      simulate: () => steps++,
      render: (a) => alphas.push(a),
    });
    loop.start();
    vi.advanceTimersByTime(2000);
    loop.stop();
    expect(steps).toBeGreaterThanOrEqual(59);
    expect(steps).toBeLessThanOrEqual(60);
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
  });

  test('a long stall is clamped to 0.25 s of catch-up (no spiral of death)', () => {
    let steps = 0;
    const loop = createLoop({ step: 1 / 60, simulate: () => steps++, render: () => {} });
    loop.start();
    frameMs = 5000; // the frame after the first one comes 5 s late (background tab, debugger…)
    vi.advanceTimersByTime(1000 / 60); // first frame: schedules the late one
    const before = steps;
    vi.advanceTimersByTime(5000); // the late frame sees a 5-s dt
    expect(performance.now()).toBeGreaterThanOrEqual(5000);
    expect(steps - before).toBe(15); // clamped: 0.25 s · 60, not 300 steps
    loop.stop();
  });

  test('stats: fps / ups after a second', () => {
    const loop = createLoop({ step: 1 / 60, simulate: () => {}, render: () => {} });
    loop.start();
    vi.advanceTimersByTime(1100);
    const s = loop.getStats();
    expect(s.fps).toBeGreaterThanOrEqual(59);
    expect(s.ups).toBeGreaterThanOrEqual(59);
    loop.stop();
  });

  test('stop() cancels the next frame', () => {
    let frames = 0;
    const loop = createLoop({ step: 1 / 60, simulate: () => {}, render: () => frames++ });
    loop.start();
    vi.advanceTimersByTime(100);
    loop.stop();
    const n = frames;
    vi.advanceTimersByTime(1000);
    expect(frames).toBe(n);
  });
});
