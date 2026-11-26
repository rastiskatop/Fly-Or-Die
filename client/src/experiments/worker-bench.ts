// Lab 7, M4: is moving snapshot decoding to a Web Worker worth it? Page: worker-bench.html
// (run by scripts/worker-bench.ts). Measures MAIN-THREAD time per snapshot, plus round-trip latency.
import { createMatchWorld, spawnPlayerShip } from '@flyordie/shared/sim/game.ts';
import {
  DT,
  buttonsToControls,
  snapshotEntities,
  collectEvents,
} from '@flyordie/shared/net/protocol.ts';
import { encodeSnapshot, decodeSnapshot } from '@flyordie/shared/net/codec-binary.ts';
import { bounds } from '@flyordie/shared/sim/arena.ts';
import { asSeq, asTick } from '@flyordie/shared/ids.ts';
import { summarize, type Summary } from '@flyordie/shared/stats.ts';

declare global {
  interface Window {
    benchResult?: unknown;
  }
}

const N = 600;

// A realistic frame: a match with 9 pilots firing for 4 s (bullets, rocks, explosions…).
const world = createMatchWorld({ ...bounds });
const events = collectEvents(world);
const ships = Array.from({ length: 9 }, (_, i) => spawnPlayerShip(world, `P${i}`));
for (let i = 0; i < 120; i++)
  world.step(
    DT,
    new Map(ships.map((s, k) => [s.id, buttonsToControls((i + k) % 4 === 0 ? 13 : 5)])),
  );
const template = encodeSnapshot({
  tick: asTick(world.tick),
  ack: asSeq(1),
  entities: snapshotEntities(world),
  events: events.slice(-6),
});
const frames = (): ArrayBuffer[] => Array.from({ length: N }, () => template.slice().buffer);

// Timers are coarsened to 100 µs without cross-origin isolation, and one decode is well under
// that — so costs are measured over a whole batch and divided (µs per frame).
function onMainUs(): number {
  const list = frames();
  const t = performance.now();
  for (const f of list) decodeSnapshot(new Uint8Array(f));
  return ((performance.now() - t) * 1000) / list.length;
}

/**
 * Main-thread µs per frame = (posting all frames) + (reading every reply's data), batched;
 * round trip = one frame at a time, there and back.
 */
async function viaWorker(mode: 'objects' | 'soa'): Promise<{ mainUs: number; roundTrip: Summary }> {
  const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
  const rtt: number[] = [];
  for (const frame of frames()) {
    const sent = performance.now();
    await new Promise<void>((resolve) => {
      worker.onmessage = (e: MessageEvent<unknown>) => {
        const data: unknown = e.data;
        if (typeof data !== 'object' || data === null) throw new Error('bad reply');
        rtt.push(performance.now() - sent);
        resolve();
      };
      worker.postMessage({ mode, frame }, [frame]); // transfer: zero-copy in, the sender loses it
    });
  }
  // Batched: post everything, then the replies arrive; time only our own main-thread work.
  const list = frames();
  let busy = 0;
  let got = 0;
  await new Promise<void>((resolve) => {
    worker.onmessage = (e: MessageEvent<unknown>) => {
      const t = performance.now();
      const data: unknown = e.data; // first access deserializes the clone — main-thread cost
      if (typeof data !== 'object' || data === null) throw new Error('bad reply');
      if (mode === 'soa' && 'x' in data && data.x instanceof Float32Array) void data.x[0];
      busy += performance.now() - t;
      if (++got === list.length) resolve();
    };
    const t = performance.now();
    for (const frame of list) worker.postMessage({ mode, frame }, [frame]);
    busy += performance.now() - t;
  });
  worker.terminate();
  return { mainUs: (busy * 1000) / list.length, roundTrip: summarize(rtt) };
}

// Warm up the JIT on both paths, then measure.
onMainUs();
await viaWorker('objects');
const result = {
  frameBytes: template.byteLength,
  entities: snapshotEntities(world).length,
  mainThreadDecodeUs: onMainUs(),
  workerClone: await viaWorker('objects'),
  workerTransferSoA: await viaWorker('soa'),
};
window.benchResult = result;
document.body.textContent = JSON.stringify(result, null, 2);
