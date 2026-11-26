// Lab 7, M4: how many players can one server process hold?
//
//   node scripts/load-test.ts [--steps=8,32,64,128,256,512] [--hold=15]
//
// For each N: N headless WebSocket clients (the `ws` package — no browser), 8 per room like real
// players, each sending one binary input per tick (30 Hz, 3× redundancy, as the real client does)
// along a scripted path: thrust in loops, turn, fire. They receive every snapshot and only count
// bytes. After a hold, /api/stats gives: tick-time p99 (worst room), event-loop utilization
// (all rooms share ONE thread), overruns, RSS, and the server's bytes/s.
// The capacity is the largest N that keeps tick p99 under the 33.3 ms budget with the event loop
// not saturated. Writes docs/lab-07/load.csv and load.svg.
import { mkdtemp, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { CpuProfileSchema, flameChartSvg, topSelfTime } from '../../scripts/profile-analysis.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { forkServer } from './fork-server.ts';
import { encodeInputs } from '@flyordie/shared/net/codec-binary.ts';
import { asSeq } from '@flyordie/shared/ids.ts';
import { BUTTON, INPUT_REDUNDANCY, TICK_RATE, type Input } from '@flyordie/shared/net/protocol.ts';
import { RoomInfoSchema } from '@flyordie/shared/net/messages.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k = '', v = ''] = a.replace(/^--/, '').split('=');
  args.set(k, v);
}
const STEPS = (args.get('steps') ?? '8,32,64,128,256,512').split(',').map(Number);
const HOLD_S = Number(args.get('hold') ?? 15);
const PER_ROOM = 8;
/** --cpuprof=1: run the server under --cpu-prof and print where its single thread's time went. */
const CPU_PROF = args.get('cpuprof') === '1';
const profDir = await mkdtemp(join(tmpdir(), 'flyordie-load-prof-'));
const BUDGET_MS = 1000 / TICK_RATE;
const outDir = join(import.meta.dirname, '..', '..', 'docs', 'lab-07');

const StatsSchema = z.object({
  matches: z.array(
    z
      .object({
        room: z.string(),
        tickP99Ms: z.number(),
        overruns: z.number(),
        entities: z.number(),
      })
      .loose(),
  ),
  process: z.object({ eventLoopUtilization: z.number(), rssMB: z.number() }),
  totals: z.object({ bytesOut: z.number(), bytesIn: z.number() }).loose(),
});

interface Client {
  readonly ws: WebSocket;
  stop(): void;
}

/** One scripted pilot: join, then 30 inputs/s along a loop pattern. */
async function pilot(wsUrl: string, room: string, index: number): Promise<Client> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ v: 1, type: 'join', room, name: `load${index}`, codec: 'binary' }));
  let seq = 0;
  const recent: Input[] = [];
  const phase = index * 17;
  const timer = setInterval(() => {
    const t = ++seq + phase;
    // A loop: thrust, a long right turn, short bursts of fire — busy but not a constant spray.
    const buttons =
      BUTTON.thrust | (t % 90 < 40 ? BUTTON.right : 0) | (t % 30 < 6 ? BUTTON.fire : 0);
    recent.push({ seq: asSeq(seq), buttons });
    if (recent.length > INPUT_REDUNDANCY) recent.shift();
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeInputs(recent));
  }, BUDGET_MS);
  return {
    ws,
    stop() {
      clearInterval(timer);
      ws.close(1000);
    },
  };
}

const server = await forkServer(
  {
    MAX_ROOMS: '200',
    MAX_PLAYERS_PER_ROOM: String(PER_ROOM),
    RATE_LIMIT_PER_SEC: '1000', // control messages only; inputs have their own bucket
    RATE_LIMIT_BURST: '1000',
    LOG_DIR: await mkdtemp(join(tmpdir(), 'flyordie-load-')),
  },
  ['ignore', 'ignore', 'inherit', 'ipc'],
  CPU_PROF ? ['--cpu-prof', `--cpu-prof-dir=${profDir}`] : [],
);
const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
const getStats = async () =>
  StatsSchema.parse(await (await fetch(`${server.base}/api/stats`)).json());

interface Row {
  n: number;
  rooms: number;
  tickP99Ms: number;
  elu: number;
  overruns: number;
  rssMB: number;
  outKBs: number;
  entities: number;
}
const rows: Row[] = [];
const rooms: string[] = [];
const clients: Client[] = [];

for (const n of STEPS) {
  // Rooms of 8: create what's missing (one POST each, like the lobby does).
  const roomsNeeded = Math.ceil(n / PER_ROOM);
  while (rooms.length < roomsNeeded) {
    const res = await fetch(`${server.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Load ${rooms.length + 1}`, arena: 'rocks' }),
    });
    rooms.push(z.object({ room: RoomInfoSchema }).parse(await res.json()).room.id);
  }
  while (clients.length < n) {
    const i = clients.length;
    const room = rooms[Math.floor(i / PER_ROOM)];
    if (!room) throw new Error('no room');
    clients.push(await pilot(wsUrl, room, i));
  }
  process.stdout.write(`[load] N=${n} in ${roomsNeeded} rooms, holding ${HOLD_S} s … `);
  await new Promise((r) => setTimeout(r, 3000)); // settle
  await getStats(); // resets the event-loop-utilization window
  const before = await getStats();
  await new Promise((r) => setTimeout(r, HOLD_S * 1000));
  const s = await getStats();
  const outKBs = (s.totals.bytesOut - before.totals.bytesOut) / 1024 / HOLD_S;
  const row: Row = {
    n,
    rooms: roomsNeeded,
    tickP99Ms: Math.max(0, ...s.matches.map((m) => m.tickP99Ms)),
    elu: s.process.eventLoopUtilization,
    overruns: s.matches.reduce((a, m) => a + m.overruns, 0),
    rssMB: s.process.rssMB,
    outKBs: Math.round(outKBs),
    entities: s.matches.reduce((a, m) => a + m.entities, 0),
  };
  rows.push(row);
  console.log(
    `tick p99 ${row.tickP99Ms} ms · ELU ${row.elu} · overruns ${row.overruns} · RSS ${row.rssMB} MB · out ${row.outKBs} KB/s`,
  );
  if (row.tickP99Ms > BUDGET_MS || row.elu > 0.95) break; // past capacity: stop ramping
}

for (const c of clients) c.stop();
await server.stop();

if (CPU_PROF) {
  const file = (await readdir(profDir)).find((f) => f.endsWith('.cpuprofile'));
  if (file) {
    const cpu = CpuProfileSchema.parse(JSON.parse(await readFile(join(profDir, file), 'utf8')));
    console.log('\nserver self time (whole run):');
    for (const t of topSelfTime(cpu, 14))
      console.log(`  ${t.pct.toFixed(1).padStart(5)} %  ${t.fn}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, 'load-flame.svg'),
      flameChartSvg(cpu, `server under load: ${STEPS.join('→')} clients`),
    );
  }
}

// ---------- report ----------
const ok = rows.filter((r) => r.tickP99Ms <= BUDGET_MS && r.elu <= 0.9);
const capacity = ok.at(-1)?.n ?? 0;
await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, 'load.csv'),
  [
    'n,rooms,tick_p99_ms,event_loop_utilization,overruns,rss_mb,out_kb_s,entities',
    ...rows.map(
      (r) =>
        `${r.n},${r.rooms},${r.tickP99Ms},${r.elu},${r.overruns},${r.rssMB},${r.outKBs},${r.entities}`,
    ),
  ].join('\n') + '\n',
);
await writeFile(join(outDir, 'load.svg'), chart(rows, capacity));
console.log('\n| N | rooms | tick p99 ms | event-loop util. | overruns | RSS MB | out KB/s |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows)
  console.log(
    `| ${r.n} | ${r.rooms} | ${r.tickP99Ms} | ${r.elu} | ${r.overruns} | ${r.rssMB} | ${r.outKBs} |`,
  );
console.log(
  `\ncapacity (tick p99 ≤ ${BUDGET_MS.toFixed(1)} ms and event loop ≤ 90 % busy): N = ${capacity}`,
);

function chart(data: readonly Row[], cap: number): string {
  const W = 760;
  const H = 380;
  const pad = { l: 58, r: 60, t: 46, b: 46 };
  const maxN = Math.max(...data.map((r) => r.n));
  const maxMs = Math.max(BUDGET_MS * 1.2, ...data.map((r) => r.tickP99Ms));
  const x = (n: number) => pad.l + (Math.log2(n) / Math.log2(maxN)) * (W - pad.l - pad.r);
  const yMs = (v: number) => H - pad.b - (v / maxMs) * (H - pad.t - pad.b);
  const yElu = (v: number) => H - pad.b - v * (H - pad.t - pad.b);
  const line = (f: (r: Row) => number, y: (v: number) => number) =>
    data.map((r) => `${x(r.n).toFixed(1)},${y(f(r)).toFixed(1)}`).join(' ');
  const dots = (f: (r: Row) => number, y: (v: number) => number, color: string) =>
    data
      .map(
        (r) =>
          `<circle cx="${x(r.n).toFixed(1)}" cy="${y(f(r)).toFixed(1)}" r="3.5" fill="${color}"/>`,
      )
      .join('');
  const ticks = data
    .map(
      (r) =>
        `<text x="${x(r.n).toFixed(1)}" y="${H - pad.b + 18}" text-anchor="middle">${r.n}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12" fill="#374151">
<rect width="100%" height="100%" fill="#fff"/>
<text x="${pad.l}" y="22" font-size="14" font-weight="600">Server load test — N headless clients, 8 per room, 30 Hz inputs</text>
<line x1="${pad.l}" x2="${W - pad.r}" y1="${yMs(BUDGET_MS)}" y2="${yMs(BUDGET_MS)}" stroke="#d64545" stroke-dasharray="6 4"/>
<text x="${W - pad.r - 4}" y="${yMs(BUDGET_MS) - 6}" text-anchor="end" fill="#d64545">tick budget 33.3 ms</text>
<polyline fill="none" stroke="#1f6feb" stroke-width="2.5" points="${line((r) => r.tickP99Ms, yMs)}"/>${dots((r) => r.tickP99Ms, yMs, '#1f6feb')}
<polyline fill="none" stroke="#e8a33d" stroke-width="2.5" points="${line((r) => r.elu, yElu)}"/>${dots((r) => r.elu, yElu, '#e8a33d')}
${ticks}
<text x="${(W + pad.l - pad.r) / 2}" y="${H - 8}" text-anchor="middle">clients N (log scale)</text>
<text x="16" y="${H / 2}" transform="rotate(-90 16 ${H / 2})" text-anchor="middle" fill="#1f6feb">worst room tick p99, ms</text>
<text x="${W - 14}" y="${H / 2}" transform="rotate(90 ${W - 14} ${H / 2})" text-anchor="middle" fill="#e8a33d">event-loop utilization (0–1)</text>
${cap ? `<line x1="${x(cap)}" x2="${x(cap)}" y1="${pad.t}" y2="${H - pad.b}" stroke="#1f9d55" stroke-width="1.5"/><text x="${x(cap) + 5}" y="${pad.t + 12}" fill="#1f9d55">capacity N = ${cap}</text>` : ''}
</svg>
`;
}
