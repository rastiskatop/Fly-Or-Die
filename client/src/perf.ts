// Lab 7, M3: User Timing spans for the DevTools Performance panel + numbers we can print.
//
//   perf.begin('render'); …; perf.end('render');
//
// Off by default and then free: one boolean check, no allocation. With ?perf=1 every span is a
// performance.mark/measure pair — it shows up in DevTools' "Timings" track — and its duration
// goes into a fixed ring buffer (no allocation per sample) for p50/p95/p99. Marks/measures are
// cleared right away so the browser's entry buffer can't grow during play.
import { SampleRing, summarize, type Summary } from '@flyordie/shared/stats.ts';

export type SpanName = 'simulate' | 'render' | 'decode' | 'reconcile';
const CAPACITY = 8192;
/** A frame interval this long means a 60 Hz frame was missed (1.25 × 16.7 ms). */
const SLOW_FRAME_MS = 20.8;
const START: Readonly<Record<SpanName, string>> = {
  simulate: 'simulate:start',
  render: 'render:start',
  decode: 'decode:start',
  reconcile: 'reconcile:start',
};

function createPerf(enabled: boolean) {
  const rings: Readonly<Record<SpanName, SampleRing>> = {
    simulate: new SampleRing(CAPACITY),
    render: new SampleRing(CAPACITY),
    decode: new SampleRing(CAPACITY),
    reconcile: new SampleRing(CAPACITY),
  };
  const frames = new SampleRing(CAPACITY);
  return {
    enabled,
    begin(name: SpanName): void {
      if (enabled) performance.mark(START[name]);
    },
    end(name: SpanName): void {
      if (!enabled) return;
      rings[name].push(performance.measure(name, START[name]).duration);
      performance.clearMarks(START[name]);
      performance.clearMeasures(name);
    },
    /** One sample per rendered frame (ms between frames). Cheap, so recorded even when spans are off. */
    frame(ms: number): void {
      frames.push(ms);
    },
    reset(): void {
      for (const r of Object.values(rings)) r.clear();
      frames.clear();
    },
    report(): { frames: Summary; slowFrames: number; spans: Record<SpanName, Summary> } {
      const f = frames.values();
      let slow = 0;
      for (const ms of f) if (ms > SLOW_FRAME_MS) slow++;
      return {
        frames: summarize(f),
        slowFrames: slow,
        spans: {
          simulate: summarize(rings.simulate.values()),
          render: summarize(rings.render.values()),
          decode: summarize(rings.decode.values()),
          reconcile: summarize(rings.reconcile.values()),
        },
      };
    },
  };
}

// ?perf=1: spans + frames; ?perf=frames: frame times only (no marks — they are Blink objects).
const PERF_FLAG =
  typeof location !== 'undefined' ? new URLSearchParams(location.search).get('perf') : null;
export const perf = createPerf(PERF_FLAG === '1');
export const perfExposed = PERF_FLAG === '1' || PERF_FLAG === 'frames';
