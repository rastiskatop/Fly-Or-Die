// Lab 7, M3: reproducible client profile — the numbers behind the before/after tables.
//
//   node scripts/profile-client.ts <label> [--seconds=30] [--bots=8] [--throttle=1] [--room=eu-2]
//
// 1. builds the client UNMINIFIED (readable function names in the profiles) into client/dist-profile
// 2. starts the real server on :8799 serving that build, adds N server-side bots to one room
// 3. opens the game in Edge (Chromium) as an autopilot pilot with ?perf=1, warms up 5 s
// 4. records for N seconds over the DevTools protocol (CDP), exactly what the DevTools panels use:
//      Tracing        → GC events (count / total / max pause), split minor vs major
//      Profiler       → CPU profile: top self-time functions + a flame chart (SVG)
//      HeapProfiler   → sampling allocation profile: top allocators (incl. collected objects)
//      window.perf    → frame-time p50/p95/p99 and the simulate/render/decode/reconcile spans
// 5. writes docs/lab-07/profile-<label>.json + flame-<label>.svg and prints a Markdown table
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type CDPSession } from '@playwright/test';
import { z } from 'zod';
import { forkServer } from '../server/scripts/fork-server.ts';
import {
  flameChartSvg,
  topSelfTime,
  topAllocators,
  CpuProfileSchema,
  HeapProfileSchema,
} from './profile-analysis.ts';

/** What the page exposes with ?perf=1 (client/src/perf.ts). */
declare global {
  interface Window {
    perf?: { report(): unknown; reset(): void };
  }
}

const args = new Map<string, string>();
for (const a of process.argv.slice(3)) {
  const [k = '', v = ''] = a.replace(/^--/, '').split('=');
  args.set(k, v);
}
const label = process.argv[2] ?? 'run';
const SECONDS = Number(args.get('seconds') ?? 30);
const BOTS = Number(args.get('bots') ?? 8);
const THROTTLE = Number(args.get('throttle') ?? 1);
const ROOM = args.get('room') ?? 'eu-2';
/** --spans=0: frame times only, no performance.mark/measure (they are Blink objects too). */
const SPANS = args.get('spans') !== '0';
/** --heap=0: no sampling heap profiler (it can change GC behaviour). */
const HEAP = args.get('heap') !== '0';
/** --promoted=1: sample only objects that SURVIVED the young generation (what fills old space). */
const PROMOTED = args.get('promoted') === '1';
/** --sound=0: no AudioContext (experiment: what do Web Audio nodes cost?). */
const SOUND = args.get('sound') !== '0';
/** --jsflags='--no-memory-reducer': V8 flags for the renderer (experiments only). */
const JS_FLAGS = args.get('jsflags') ?? '';
const root = join(import.meta.dirname, '..');
const outDir = join(root, 'docs', 'lab-07');

const SummarySchema = z.object({
  n: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
  mean: z.number(),
});
const ReportSchema = z.object({
  frames: SummarySchema,
  slowFrames: z.number(),
  spans: z.object({
    simulate: SummarySchema,
    render: SummarySchema,
    decode: SummarySchema,
    reconcile: SummarySchema,
  }),
});
const TraceEventSchema = z
  .object({
    name: z.string(),
    ph: z.string(),
    dur: z.number().optional(),
    tid: z.number().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
type TraceEvent = z.infer<typeof TraceEventSchema>;

console.log(`[profile] building the client (unminified) …`);
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build',
    '--minify',
    'false',
    '--outDir',
    'dist-profile',
    '--emptyOutDir',
  ],
  {
    cwd: join(root, 'client'),
    stdio: 'ignore',
  },
);

const server = await forkServer({
  PORT: '8799',
  STATIC_DIR: '../client/dist-profile',
  MAX_PLAYERS_PER_ROOM: String(BOTS + 2),
  LOG_DIR: await mkdtemp(join(tmpdir(), 'flyordie-profile-')),
});
const botsRes = await fetch(`${server.base}/api/rooms/${ROOM}/bots`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ count: BOTS }),
});
console.log(`[profile] server ${server.base}, bots: ${await botsRes.text()}`);

const browser = await chromium.launch({
  channel: process.env.CI ? undefined : 'msedge',
  headless: true,
  args: JS_FLAGS ? [`--js-flags=${JS_FLAGS}`] : [],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(
  `${server.base}/?join=${ROOM}&name=Profiler&autopilot=1&perf=${SPANS ? '1' : 'frames'}&netgraph=0${SOUND ? '' : '&sound=0'}`,
);
await page.waitForFunction(
  () => {
    const r = window.perf?.report();
    return (
      typeof r === 'object' &&
      r !== null &&
      'frames' in r &&
      typeof r.frames === 'object' &&
      r.frames !== null &&
      'n' in r.frames &&
      Number(r.frames.n) > 30
    );
  },
  undefined,
  { timeout: 20_000 },
);

const cdp: CDPSession = await page.context().newCDPSession(page);
if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
console.log(`[profile] warm-up 5 s, then recording ${SECONDS} s (CPU throttle ×${THROTTLE}) …`);
await page.waitForTimeout(5000);

// --- start recording ---
const gcEvents: TraceEvent[] = [];
let traceEvents = 0;
cdp.on('Tracing.dataCollected', ({ value }) => {
  for (const raw of value) {
    traceEvents++;
    const e = TraceEventSchema.safeParse(raw);
    if (e.success && e.data.ph === 'X' && /GC/.test(e.data.name)) gcEvents.push(e.data);
  }
});
const traceDone = new Promise<void>((resolve) =>
  cdp.once('Tracing.tracingComplete', () => resolve()),
);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); // µs
await cdp.send('HeapProfiler.enable');
await page.evaluate(() => window.perf?.reset());
await cdp.send('Tracing.start', {
  categories: 'devtools.timeline,disabled-by-default-v8.gc',
  transferMode: 'ReportEvents',
});
await cdp.send('Profiler.start');
if (HEAP)
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: !PROMOTED,
  });

await page.waitForTimeout(SECONDS * 1000);

// --- stop ---
const report = ReportSchema.parse(await page.evaluate(() => window.perf?.report()));
const heap = HEAP
  ? HeapProfileSchema.parse((await cdp.send('HeapProfiler.stopSampling')).profile)
  : null;
const cpu = CpuProfileSchema.parse((await cdp.send('Profiler.stop')).profile);
await cdp.send('Tracing.end');
await traceDone;
await browser.close();
const bots = await fetch(`${server.base}/api/rooms/${ROOM}/bots`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"count":0}',
});
await bots.text();
await server.stop();

// --- analyse ---
function gcSummary(names: readonly string[]): { count: number; totalMs: number; maxMs: number } {
  const evs = gcEvents.filter((e) => names.includes(e.name));
  const durs = evs.map((e) => (e.dur ?? 0) / 1000);
  return {
    count: evs.length,
    totalMs: +durs.reduce((a, b) => a + b, 0).toFixed(1),
    maxMs: +Math.max(0, ...durs).toFixed(2),
  };
}
const gcByName = new Map<string, number>();
for (const e of gcEvents) gcByName.set(e.name, (gcByName.get(e.name) ?? 0) + 1);
const result = {
  label,
  environment: {
    browser: browser.version(),
    seconds: SECONDS,
    bots: BOTS,
    throttle: THROTTLE,
    room: ROOM,
    spans: SPANS,
    heapProfiler: HEAP,
    sound: SOUND,
    jsFlags: JS_FLAGS,
    node: process.version,
    platform: process.platform,
  },
  frames: report.frames,
  slowFrames: report.slowFrames,
  spans: report.spans,
  gc: {
    minor: gcSummary(['MinorGC']),
    major: gcSummary(['MajorGC']),
    // V8's own account of each major GC: why it ran, heap before/after
    majorDetails: gcEvents
      .filter((e) => e.name === 'MajorGC')
      .map((e) => ({ ms: +((e.dur ?? 0) / 1000).toFixed(2), ...e.args })),
    eventNames: Object.fromEntries(gcByName),
    traceEvents,
  },
  topSelf: topSelfTime(cpu, 8),
  topAllocators: heap ? topAllocators(heap, 8) : [],
};
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `profile-${label}.json`), JSON.stringify(result, null, 2) + '\n');
await writeFile(
  join(outDir, `flame-${label}.svg`),
  flameChartSvg(cpu, `client, ${label}: ${SECONDS} s, ${BOTS} bots`),
);

const f = (n: number) => n.toFixed(2);
console.log(`\n### ${label}\n`);
console.log(
  `| frame ms p50 | p95 | p99 | max | frames > 20.8 ms | render ms p50/p99 | minor GCs (total ms) | major GCs (total ms, max) |`,
);
console.log(`|---|---|---|---|---|---|---|---|`);
console.log(
  `| ${f(report.frames.p50)} | ${f(report.frames.p95)} | ${f(report.frames.p99)} | ${f(report.frames.max)} | ${report.slowFrames} of ${report.frames.n} | ${f(report.spans.render.p50)}/${f(report.spans.render.p99)} | ${result.gc.minor.count} (${result.gc.minor.totalMs}) | ${result.gc.major.count} (${result.gc.major.totalMs}, ${result.gc.major.maxMs}) |`,
);
console.log(
  `\nspans (ms p50/p99): ${Object.entries(report.spans)
    .map(([k, s]) => `${k} ${f(s.p50)}/${f(s.p99)} (n=${s.n})`)
    .join(' · ')}`,
);
console.log(`\ntop self time:`);
for (const t of result.topSelf)
  console.log(
    `  ${t.selfMs.toFixed(0).padStart(6)} ms  ${t.pct.toFixed(1).padStart(5)} %  ${t.fn}`,
  );
console.log(`top allocators:`);
for (const a of result.topAllocators)
  console.log(`  ${(a.bytes / 2 ** 20).toFixed(1).padStart(7)} MB  ${a.fn}`);
console.log(`\nwrote docs/lab-07/profile-${label}.json and flame-${label}.svg`);
