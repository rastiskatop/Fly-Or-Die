// Lab 8, M2: chaos tests with the metrics that prove what happened.
//
//   node scripts/chaos.ts
//
// A. garbage flood: ≥ 1,000 junk frames/s at the server while a 6-bot match runs in another room.
//    Every junk socket must be closed, logged and counted (flyordie_ws_rejections_total), and the
//    other room's tick p99 must not move (each phase measured on a fresh match = a fresh window).
// B. a client killed mid-match (socket destroyed, no close frame): the other player sees the roster
//    update; the room and its match go on.
// C. the SERVER killed mid-match (hard kill, no shutdown): the browser's own Connection class
//    reconnects with exponential backoff; we restart the server and time the reconnect.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import { forkServer, type ForkedServer } from './fork-server.ts';
import { toBuffer } from '../src/ws.ts';
import { Connection, type StatusInfo } from '../../client/src/net/connection.ts';

const outDir = join(import.meta.dirname, '..', '..', 'docs', 'lab-08');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = async (port = '0') => ({
  PORT: port,
  LOG_LEVEL: 'error',
  MAX_CONNECTIONS_PER_IP: '64',
  LOG_DIR: await mkdtemp(join(tmpdir(), 'flyordie-chaos-')),
});

const StatsSchema = z.object({
  matches: z.array(
    z.object({ room: z.string(), tickP99Ms: z.number(), ticks: z.number() }).loose(),
  ),
  process: z.object({ eventLoopUtilization: z.number() }),
});
const stats = async (s: ForkedServer) =>
  StatsSchema.parse(await (await fetch(`${s.base}/api/stats`)).json());
const setBots = async (s: ForkedServer, room: string, count: number) =>
  (
    await fetch(`${s.base}/api/rooms/${room}/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count }),
    })
  ).text();
async function rejections(s: ForkedServer): Promise<Record<string, number>> {
  const text = await (await fetch(`${s.base}/metrics`)).text();
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^flyordie_ws_rejections_total\{reason="([^"]+)"[^}]*\} (\d+)/gm))
    out[m[1] ?? '?'] = Number(m[2]);
  return out;
}

// ---------- A. garbage flood vs another room's tick time ----------
async function flood(): Promise<Record<string, unknown>> {
  const server = await forkServer(await env());
  const PHASE_MS = 12_000;
  const measure = async (withFlood: boolean) => {
    await setBots(server, 'eu-2', 6); // a fresh match = a fresh 60-s tick window
    await sleep(1000);
    await stats(server); // reset the event-loop-utilization window
    let sent = 0;
    let sockets = 0;
    let running = withFlood;
    const flooders = withFlood
      ? Array.from({ length: 16 }, async () => {
          while (running) {
            const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
            sockets++;
            ws.on('error', () => {});
            await new Promise<void>((resolve) => {
              ws.on('open', () => {
                // 64 junk frames back to back: text that isn't JSON, then random binary
                for (let i = 0; i < 64 && ws.readyState === WebSocket.OPEN; i++) {
                  ws.send(
                    i % 2
                      ? '{"v":1,"type":"teleport'
                      : Buffer.from([2, 9, 9, 9, Math.random() * 255]),
                  );
                  sent++;
                }
              });
              ws.on('close', () => resolve());
              setTimeout(() => {
                ws.terminate();
                resolve();
              }, 500);
            });
          }
        })
      : [];
    const t0 = Date.now();
    await sleep(PHASE_MS);
    running = false;
    await Promise.all(flooders);
    const s = await stats(server);
    const room = s.matches.find((m) => m.room === 'eu-2');
    await setBots(server, 'eu-2', 0);
    await sleep(300);
    return {
      tickP99Ms: room?.tickP99Ms ?? NaN,
      ticks: room?.ticks ?? 0,
      elu: s.process.eventLoopUtilization,
      junkFrames: sent,
      junkPerSec: Math.round(sent / ((Date.now() - t0) / 1000)),
      junkSockets: sockets,
    };
  };
  const before = await rejections(server);
  const baseline = await measure(false);
  const flooded = await measure(true);
  const after = await rejections(server);
  await server.stop();
  const delta = Object.fromEntries(
    Object.entries(after)
      .map(([k, v]): [string, number] => [k, v - (before[k] ?? 0)])
      .filter(([, v]) => v > 0),
  );
  return { baseline, flooded, rejectionsDuringFlood: delta };
}

// ---------- B. a client killed mid-match ----------
async function killClient(): Promise<Record<string, unknown>> {
  const server = await forkServer(await env());
  const join = async (name: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const rosters: number[] = [];
    ws.on('message', (d: RawData, bin: boolean) => {
      if (bin) return;
      const m: unknown = JSON.parse(toBuffer(d).toString());
      if (
        typeof m === 'object' &&
        m &&
        'type' in m &&
        m.type === 'roster' &&
        'players' in m &&
        Array.isArray(m.players)
      )
        rosters.push(m.players.length);
    });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ v: 1, type: 'join', room: 'us-1', name, codec: 'binary' }));
    return { ws, rosters };
  };
  const a = await join('Survivor');
  const b = await join('Victim');
  await sleep(500);
  const t0 = Date.now();
  b.ws.terminate(); // the socket just dies: no close frame (crashed tab, lost Wi-Fi)
  while (a.rosters.at(-1) !== 1 && Date.now() - t0 < 5000) await sleep(10);
  const noticedMs = Date.now() - t0;
  const s = await stats(server);
  a.ws.close();
  await server.stop();
  return {
    rosterUpdatedAfterMs: noticedMs,
    survivorRoster: a.rosters.at(-1),
    matchStillRunning: s.matches.some((m) => m.room === 'us-1'),
  };
}

// ---------- C. the server killed mid-match ----------
async function killServer(): Promise<Record<string, unknown>> {
  const PORT = '8833';
  let server = await forkServer(await env(PORT));
  const conn = new Connection(`ws://127.0.0.1:${PORT}/ws`, { baseMs: 500, maxMs: 4000 });
  const statuses: (StatusInfo & { t: number })[] = [];
  let welcomes = 0;
  const t0 = Date.now();
  conn.on('status', (s) => statuses.push({ ...s, t: Date.now() - t0 }));
  conn.on('open', () =>
    conn.sendNow({ type: 'join', room: 'eu-1', name: 'Phoenix', codec: 'binary' }),
  );
  conn.on('welcome', () => {
    welcomes++;
    conn.markReady();
  });
  conn.connect();
  while (welcomes < 1) await sleep(20);
  await sleep(500);

  const killedAt = Date.now() - t0;
  server.child.kill('SIGKILL'); // a crash: no 1001, no goodbye
  await sleep(3000); // the server is down for 3 s
  server = await forkServer(await env(PORT));
  const restartedAt = Date.now() - t0;
  while (welcomes < 2 && Date.now() - t0 < restartedAt + 15_000) await sleep(20);
  const rejoinedAt = Date.now() - t0;
  conn.close();
  await server.stop();
  const waits = statuses.filter((s) => s.state === 'waiting');
  return {
    killedAtMs: killedAt,
    restartedAtMs: restartedAt,
    rejoinedAfterRestartMs: welcomes >= 2 ? rejoinedAt - restartedAt : null,
    backoff: waits.map((w) => ({ attempt: w.attempt, delayMs: w.delayMs, code: w.code })),
  };
}

const result = {
  flood: await flood(),
  clientKill: await killClient(),
  serverKill: await killServer(),
};
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'chaos.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
