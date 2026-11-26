// Event-loop blocking demo (Lab 4, M4).
// Two players chat in a room: Alice sends a message every 50 ms with a timestamp, Bob measures how
// long each one took to arrive. Meanwhile someone calls GET /api/debug/block?ms=300 three times —
// a handler that busy-waits 300 ms. Every connected client feels it.
//   node scripts/demo-blocking.ts
import { once } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { ServerMessageSchema } from '@flyordie/shared/net/messages.ts';
import { forkServer } from './fork-server.ts';

const server = await forkServer({
  DEBUG_ROUTES: 'true',
  RATE_LIMIT_PER_SEC: '100',
  RATE_LIMIT_BURST: '100',
});
const { port, base } = server;

async function player(name: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ v: 1, type: 'join', room: 'eu-1', name }));
  return ws;
}
const alice = await player('Alice');
const bob = await player('Bob');

const t0 = performance.now();
const now = () => performance.now() - t0;
interface Latency {
  readonly at: number;
  readonly ms: number;
}
const latencies: Latency[] = [];
bob.on('message', (raw: RawData) => {
  const parsed = ServerMessageSchema.safeParse(JSON.parse(raw.toString()));
  if (!parsed.success) return;
  const m = parsed.data;
  if (m.type === 'chat' && m.from.name === 'Alice') {
    const sent = Number(m.text.split(' ')[1]);
    latencies.push({ at: sent, ms: now() - sent });
  }
});

const sender = setInterval(
  () => alice.send(JSON.stringify({ v: 1, type: 'chat', text: `t ${now().toFixed(1)}` })),
  50,
);

const blocks: [start: number, end: number][] = [];
for (const at of [1000, 2000, 3000]) {
  setTimeout(async () => {
    const start = now();
    await fetch(`${base}/api/debug/block?ms=300`);
    blocks.push([start, now()]);
  }, at);
}

await new Promise((r) => setTimeout(r, 4000));
clearInterval(sender);
alice.close();
bob.close();
await server.stop();

const during = (l: Latency): boolean => blocks.some(([a, b]) => l.at >= a - 50 && l.at <= b);
const calm = latencies.filter((l) => !during(l)).map((l) => l.ms);
const hit = latencies.filter(during).map((l) => l.ms);
const stats = (xs: readonly number[]): string => {
  const s = [...xs].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)] ?? NaN;
  return `n=${s.length} median=${median.toFixed(1)} ms max=${(s.at(-1) ?? NaN).toFixed(1)} ms`;
};
console.log(`chat latency, normal:           ${stats(calm)}`);
console.log(`chat latency, during a block:   ${stats(hit)}`);
console.log('timeline (ms since start → delivery latency):');
for (const l of latencies.filter((l) => l.at > 900 && l.at < 1450)) {
  console.log(
    `  sent at ${l.at.toFixed(0).padStart(5)} → ${l.ms.toFixed(0).padStart(4)} ms ${'█'.repeat(Math.round(l.ms / 10))}`,
  );
}
