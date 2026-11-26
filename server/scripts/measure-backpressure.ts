// Backpressure experiment (Lab 4, M3).
// Starts the server, downloads the 200 MB replay with a client throttled to RATE MB/s, and samples
// the server's rss (via /health) while it streams. Twice:
//   1. GET /api/replays/:id                → pipeline(readStream, res)     (respects backpressure)
//   2. GET /api/debug/replays/:id/naive    → on('data', c => res.write(c)) (ignores write() === false)
// Writes docs/lab-04/backpressure.csv and docs/lab-04/backpressure.svg.
//   node scripts/gen-big-log.ts 200 && node scripts/measure-backpressure.ts [MBps=10]
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { HealthSchema } from '@flyordie/shared/net/messages.ts';
import { forkServer } from './fork-server.ts';

const RATE_MBPS = Number(process.argv[2] ?? 10);
const REPLAY = 'synthetic-200mb';
const root = join(import.meta.dirname, '..', '..');
const outDir = join(root, 'docs', 'lab-04');

const RssSchema = HealthSchema.extend({ rssMB: z.number() });
const health = async (base: string): Promise<z.infer<typeof RssSchema>> =>
  RssSchema.parse(await (await fetch(`${base}/health`)).json());

type Mode = 'pipeline' | 'naive';
interface Sample {
  readonly t: number;
  readonly rssMB: number;
  readonly downloadedMB: number;
}
interface Run {
  readonly label: Mode;
  readonly samples: readonly Sample[];
  readonly peak: number;
  readonly secs: number;
}

/** A consumer that can only absorb RATE_MBPS — like a client on a slow link. */
function throttledSink(): { sink: Writable; received: () => number } {
  const bytesPerMs = (RATE_MBPS * 2 ** 20) / 1000;
  let received = 0;
  const sink = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      setTimeout(cb, chunk.length / bytesPerMs);
    },
  });
  return { sink, received: () => received };
}

async function run(label: Mode, path: string): Promise<Run> {
  const server = await forkServer({ DEBUG_ROUTES: 'true' });
  const { base } = server;
  const samples: Sample[] = [];
  const t0 = performance.now();
  const { sink, received } = throttledSink();
  const sampler = setInterval(async () => {
    try {
      const h = await health(base);
      samples.push({
        t: (performance.now() - t0) / 1000,
        rssMB: h.rssMB,
        downloadedMB: received() / 2 ** 20,
      });
    } catch {
      /* server busy */
    }
  }, 250);

  await new Promise<void>((resolve, reject) => {
    http
      .get(`${base}${path}`, (res) => {
        if (res.statusCode !== 200)
          return reject(new Error(`${path}: HTTP ${res.statusCode ?? '?'}`));
        pipeline(res, sink).then(resolve, reject);
      })
      .on('error', reject);
  });
  clearInterval(sampler);
  await server.stop();

  const peak = Math.max(...samples.map((s) => s.rssMB));
  const secs = (performance.now() - t0) / 1000;
  console.log(`${label.padEnd(9)} ${secs.toFixed(1)} s, peak server rss ${peak.toFixed(0)} MB`);
  return { label, samples, peak, secs };
}

function chart(runs: readonly Run[]): string {
  const W = 760;
  const H = 360;
  const pad = { l: 56, r: 20, t: 40, b: 44 };
  const maxT = Math.max(...runs.flatMap((r) => r.samples.map((s) => s.t)));
  const maxY = Math.ceil(Math.max(...runs.map((r) => r.peak)) / 50) * 50;
  const x = (t: number): number => pad.l + (t / maxT) * (W - pad.l - pad.r);
  const y = (v: number): number => H - pad.b - (v / maxY) * (H - pad.t - pad.b);
  const colors: Record<Mode, string> = { pipeline: '#1f9d55', naive: '#d64545' };
  const grid: string[] = [];
  for (let v = 0; v <= maxY; v += maxY / 5) {
    grid.push(
      `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/>`,
      `<text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(0)}</text>`,
    );
  }
  for (let t = 0; t <= maxT; t += 5) {
    grid.push(`<text x="${x(t)}" y="${H - pad.b + 18}" text-anchor="middle">${t}s</text>`);
  }
  const lines = runs.map((r) => {
    const pts = r.samples.map((s) => `${x(s.t).toFixed(1)},${y(s.rssMB).toFixed(1)}`).join(' ');
    return `<polyline fill="none" stroke="${colors[r.label]}" stroke-width="2.5" points="${pts}"/>`;
  });
  const legend = runs.map(
    (r, i) =>
      `<g transform="translate(${pad.l + 12 + i * 330} ${pad.t - 16})"><rect width="14" height="4" y="-4" fill="${colors[r.label]}"/>` +
      `<text x="20" y="0">${r.label === 'pipeline' ? 'pipeline(file, res)' : "on('data') → res.write() (naive)"} — peak ${r.peak.toFixed(0)} MB</text></g>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12" fill="#374151">
<rect width="100%" height="100%" fill="#ffffff"/>
${grid.join('\n')}
<text x="16" y="${H / 2}" transform="rotate(-90 16 ${H / 2})" text-anchor="middle">server rss, MB</text>
<text x="${(W + pad.l) / 2}" y="${H - 8}" text-anchor="middle">time — 200 MB replay to a client reading ${RATE_MBPS} MB/s</text>
${lines.join('\n')}
${legend.join('\n')}
</svg>
`;
}

const runs: Run[] = [];
runs.push(await run('pipeline', `/api/replays/${REPLAY}`));
runs.push(await run('naive', `/api/debug/replays/${REPLAY}/naive`));

await mkdir(outDir, { recursive: true });
const csv = ['mode,t_s,rss_mb,downloaded_mb'];
for (const r of runs)
  for (const s of r.samples)
    csv.push(`${r.label},${s.t.toFixed(2)},${s.rssMB},${s.downloadedMB.toFixed(1)}`);
await writeFile(join(outDir, 'backpressure.csv'), csv.join('\n') + '\n');
await writeFile(join(outDir, 'backpressure.svg'), chart(runs));
console.log(`wrote ${join(outDir, 'backpressure.svg')}`);
