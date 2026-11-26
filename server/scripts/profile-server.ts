// Lab 7, M3 (server): `node --cpu-prof` on a real match full of bots.
//
//   node scripts/profile-server.ts <label> [--seconds=60] [--bots=24] [--room=eu-2]
//
// Forks the server with --cpu-prof, fills one room with server-side bots (they shoot a lot: many
// bullets → many collision candidates), lets the match run, reads the tick-time percentiles and
// event-loop utilization from /api/stats, stops the server gracefully (Node writes the
// .cpuprofile on exit), then prints the top self-time functions and writes a flame chart.
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { forkServer } from './fork-server.ts';
import { CpuProfileSchema, flameChartSvg, topSelfTime } from '../../scripts/profile-analysis.ts';

const label = process.argv[2] ?? 'run';
const args = new Map<string, string>();
for (const a of process.argv.slice(3)) {
  const [k = '', v = ''] = a.replace(/^--/, '').split('=');
  args.set(k, v);
}
const SECONDS = Number(args.get('seconds') ?? 60);
const BOTS = Number(args.get('bots') ?? 24);
const ROOM = args.get('room') ?? 'eu-2';
const outDir = join(import.meta.dirname, '..', '..', 'docs', 'lab-07');

const StatsSchema = z.object({
  matches: z.array(
    z
      .object({
        room: z.string(),
        entities: z.number(),
        tickP50Ms: z.number(),
        tickP95Ms: z.number(),
        tickP99Ms: z.number(),
        durationMaxMs: z.number(),
        overruns: z.number(),
      })
      .loose(),
  ),
  process: z.object({
    eventLoopUtilization: z.number(),
    rssMB: z.number(),
    heapUsedMB: z.number(),
  }),
});

const profDir = await mkdtemp(join(tmpdir(), 'flyordie-cpuprof-'));
const server = await forkServer(
  {
    MAX_PLAYERS_PER_ROOM: String(BOTS + 1),
    LOG_DIR: await mkdtemp(join(tmpdir(), 'flyordie-logs-')),
  },
  ['ignore', 'ignore', 'inherit', 'ipc'],
  ['--cpu-prof', `--cpu-prof-dir=${profDir}`, '--cpu-prof-interval=500'],
);
const post = (path: string, body: unknown) =>
  fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
console.log(
  `[profile-server] ${BOTS} bots in ${ROOM}: ${await (await post(`/api/rooms/${ROOM}/bots`, { count: BOTS })).text()}`,
);

// Sample entity counts while it runs (the tick percentiles cover the last 60 s).
const entities: number[] = [];
const sampler = setInterval(() => {
  void fetch(`${server.base}/api/stats`)
    .then(async (r) => StatsSchema.parse(await r.json()))
    .then((s) => {
      const m = s.matches.find((x) => x.room === ROOM);
      if (m) entities.push(m.entities);
    })
    .catch(() => {});
}, 1000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(sampler);

const stats = StatsSchema.parse(await (await fetch(`${server.base}/api/stats`)).json());
const match = stats.matches.find((m) => m.room === ROOM);
await (await post(`/api/rooms/${ROOM}/bots`, { count: 0 })).text();
console.log(`[profile-server] stopping (exit code ${await server.stop()})`);

const file = (await readdir(profDir)).find((f) => f.endsWith('.cpuprofile'));
if (!file) throw new Error('no .cpuprofile written');
const cpu = CpuProfileSchema.parse(JSON.parse(await readFile(join(profDir, file), 'utf8')));
const top = topSelfTime(cpu, 10);
const meanEntities = entities.length ? entities.reduce((a, b) => a + b, 0) / entities.length : 0;
const result = {
  label,
  seconds: SECONDS,
  bots: BOTS,
  room: ROOM,
  meanEntities: Math.round(meanEntities),
  match,
  process: stats.process,
  topSelf: top,
};
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `server-${label}.json`), JSON.stringify(result, null, 2) + '\n');
await writeFile(
  join(outDir, `server-flame-${label}.svg`),
  flameChartSvg(
    cpu,
    `server, ${label}: ${SECONDS} s, ${BOTS} bots, ~${Math.round(meanEntities)} entities`,
  ),
);

console.log(
  `\n### server ${label}: ${BOTS} bots, ~${Math.round(meanEntities)} entities, ${SECONDS} s\n`,
);
console.log('| tick p50 ms | p95 | p99 | max | overruns | event-loop utilization |');
console.log('|---|---|---|---|---|---|');
console.log(
  `| ${match?.tickP50Ms} | ${match?.tickP95Ms} | ${match?.tickP99Ms} | ${match?.durationMaxMs} | ${match?.overruns} | ${stats.process.eventLoopUtilization} |`,
);
console.log('\ntop self time:');
for (const t of top)
  console.log(
    `  ${t.selfMs.toFixed(0).padStart(6)} ms  ${t.pct.toFixed(1).padStart(5)} %  ${t.fn}`,
  );
console.log(`\nwrote docs/lab-07/server-${label}.json and server-flame-${label}.svg`);
