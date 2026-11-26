// Integration: starts the real server (child process, random port, temp LOG_DIR) and talks to it
// over HTTP and WebSocket like a browser would.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { binaryCodec } from '@flyordie/shared/net/codec.ts';
import { toBuffer } from '../src/ws.ts';
import { firstArg } from '../scripts/fork-server.ts';
import { asSeq } from '@flyordie/shared/ids.ts';
import type { Snapshot } from '@flyordie/shared/net/protocol.ts';
import {
  HealthSchema,
  RoomsResponseSchema,
  ServerMessageSchema,
  type ServerMessage,
} from '@flyordie/shared/net/messages.ts';

let child: ChildProcess;
let base = '';
let wsUrl = '';
let logDir = '';

const Listening = z.object({ type: z.literal('listening'), port: z.number() });

before(async () => {
  logDir = await mkdtemp(join(tmpdir(), 'flyordie-logs-'));
  child = fork(join(import.meta.dirname, '..', 'src', 'index.ts'), [], {
    env: {
      ...process.env,
      PORT: '0',
      LOG_DIR: logDir,
      JOIN_TIMEOUT_MS: '300',
      RATE_LIMIT_PER_SEC: '5',
      RATE_LIMIT_BURST: '5',
      MAX_PAYLOAD_BYTES: '1024',
      MAX_PLAYERS_PER_ROOM: '2',
      MAX_CONNECTIONS_PER_IP: '8',
      NODE_ENV: 'production', // production rules: same-origin only, no localhost exception
      DEBUG_ROUTES: 'true',
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    execArgv: [], // a plain `node src/index.ts`: don't inherit the test runner's flags
  });
  const msg = await firstArg(child, 'message');
  const { port } = Listening.parse(msg);
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  child.send({ type: 'shutdown' }); // graceful: closes sockets, flushes logs, exits 0
  const code = await firstArg(child, 'exit');
  assert.equal(code, 0);
});

/** GET + JSON, validated: the server's own responses must match the shared schemas too. */
async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await fetch(url)).json());
}

type Msg = ServerMessage;
type MsgOf<K extends Msg['type']> = Extract<Msg, { type: K }>;

/** Opens a socket; every server message is parsed with ServerMessageSchema (so malformed output fails the test). */
async function client() {
  const ws = new WebSocket(wsUrl);
  const messages: Msg[] = [];
  ws.on('message', (d: RawData, isBinary: boolean) => {
    if (!isBinary) messages.push(ServerMessageSchema.parse(JSON.parse(toBuffer(d).toString())));
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));
  await once(ws, 'open');
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...m }));
  /** Waits for the first message of type K that satisfies `pred` — typed as that message. */
  const waitFor = async <K extends Msg['type']>(
    type: K,
    pred: (m: MsgOf<K>) => boolean = () => true,
    ms = 2000,
  ): Promise<MsgOf<K>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const m of messages) if (isType(m, type) && pred(m)) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${type}; got ${JSON.stringify(messages)}`);
  };
  return { ws, messages, send, waitFor, closed };
}

function isType<K extends Msg['type']>(m: Msg, type: K): m is MsgOf<K> {
  return m.type === type;
}

test('GET /health and /api/rooms', async () => {
  const health = await getJson(`${base}/health`, HealthSchema);
  assert.equal(health.status, 'ok');
  const { rooms } = await getJson(`${base}/api/rooms`, RoomsResponseSchema);
  assert.ok(rooms.some((r) => r.id === 'eu-1'));
});

test('POST /api/rooms validates and caps the body', async () => {
  const post = (body: unknown) =>
    fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ name: 'Test', arena: 'calm' })).status, 201);
  assert.equal((await post({ name: 'Test', arena: 'moon' })).status, 400);
  assert.equal((await post({ name: 'x'.repeat(5000) })).status, 413);
});

test('two clients join one room, see each other, chat', async () => {
  const a = await client();
  const b = await client();
  a.send({ type: 'join', room: 'eu-1', name: 'Alice' });
  await a.waitFor('welcome');
  b.send({ type: 'join', room: 'eu-1', name: 'Bob' });
  await b.waitFor('welcome');

  const roster = await a.waitFor('roster', (m) => m.players.length === 2);
  assert.deepEqual(roster.players.map((p) => p.name).sort(), ['Alice', 'Bob']);
  assert.ok(
    roster.players.every((p) => typeof p.shipId === 'number'),
    'every player has a ship',
  );

  b.send({ type: 'chat', text: 'hello Alice' });
  const chat = await a.waitFor('chat');
  assert.equal(chat.from.name, 'Bob');
  assert.equal(chat.text, 'hello Alice');

  // room cap is 2 for this test server
  const c = await client();
  c.send({ type: 'join', room: 'eu-1', name: 'Carol' });
  assert.equal(await c.closed, 4004);

  b.ws.close(1000);
  await a.waitFor('roster', (m) => m.players.length === 1);
  a.ws.close(1000);
  await a.closed;
});

test('protocol violations close the socket with a code', async () => {
  const bad = await client();
  bad.ws.send('not json');
  assert.equal(await bad.closed, 4000);

  const unknown = await client();
  unknown.send({ type: 'join', room: 'eu-2', name: 'X' });
  await unknown.waitFor('welcome');
  unknown.send({ type: 'teleport', x: 1 });
  assert.equal(await unknown.closed, 4001);

  const silent = await client(); // never sends join
  assert.equal(await silent.closed, 4003);

  const big = await client();
  big.ws.send('x'.repeat(4096)); // over MAX_PAYLOAD_BYTES=1024
  assert.equal(await big.closed, 1009);
});

test('rate limit: a flood closes the socket with 1008', async () => {
  const spam = await client();
  spam.send({ type: 'join', room: 'eu-2', name: 'Spam' });
  await spam.waitFor('welcome');
  for (let i = 0; i < 20; i++) spam.send({ type: 'chat', text: `spam ${i}` });
  assert.equal(await spam.closed, 1008);
});

test('binary netcode: inputs up, snapshots down with this client ack', async () => {
  const ws = new WebSocket(wsUrl);
  const snaps: Snapshot[] = [];
  let tickRate = 0;
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) snaps.push(binaryCodec.decodeSnapshot(toBuffer(data)));
    else {
      const msg = ServerMessageSchema.parse(JSON.parse(toBuffer(data).toString()));
      if (msg.type === 'welcome') tickRate = msg.tickRate;
    }
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ v: 1, type: 'join', room: 'us-1', name: 'Bin', codec: 'binary' }));
  for (let seq = 1; seq <= 10; seq++) {
    ws.send(binaryCodec.encodeInputs([{ seq: asSeq(seq), buttons: 4 }])); // thrust
    await new Promise((r) => setTimeout(r, 34));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tickRate, 30);
  assert.ok(snaps.length >= 10, `got ${snaps.length} snapshots`);
  const last = snaps.at(-1);
  assert.equal(last?.ack, 10); // every input applied exactly once, in order
  assert.ok(snaps.every((s, i) => i === 0 || s.tick > (snaps[i - 1]?.tick ?? -1)));
  assert.ok(last?.entities.some((e) => e.kind === 'ship'));
  ws.send(Buffer.from([1, 1, 0])); // malformed binary inputs
  const code = await firstArg(ws, 'close');
  assert.equal(code, 4000);
});

test('POST /api/rooms/:id/bots: bots take slots, play (their inputs are acked), and leave on 0', async () => {
  const setBots = (room: string, body: unknown) =>
    fetch(`${base}/api/rooms/${room}/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const BotsResponse = z.object({ room: z.string(), bots: z.number() });
  const StatsSchema = z
    .object({
      matches: z.array(
        z.object({ room: z.string(), players: z.number(), starved: z.number(), ticks: z.number() }),
      ),
    })
    .loose();

  assert.equal((await setBots('eu-2', { count: -1 })).status, 400);
  assert.equal((await setBots('nowhere', { count: 1 })).status, 404);
  const res = await setBots('eu-2', { count: 5 }); // the room cap is 2 for this test server
  assert.equal(res.status, 200);
  assert.equal(BotsResponse.parse(await res.json()).bots, 2);

  const { rooms } = await getJson(`${base}/api/rooms`, RoomsResponseSchema);
  assert.equal(rooms.find((r) => r.id === 'eu-2')?.players, 2);

  await new Promise((r) => setTimeout(r, 400)); // ~12 ticks
  const stats = await getJson(`${base}/api/stats`, StatsSchema);
  const match = stats.matches.find((m) => m.room === 'eu-2');
  assert.ok(match && match.ticks >= 8, 'the match runs');
  assert.equal(match.players, 2);
  assert.ok(match.starved <= 2, `bots send an input every tick (starved ${match.starved})`);

  assert.equal(BotsResponse.parse(await (await setBots('eu-2', { count: 0 })).json()).bots, 0);
  const after = await getJson(`${base}/api/stats`, StatsSchema);
  assert.equal(
    after.matches.find((m) => m.room === 'eu-2'),
    undefined,
    'empty room → match stopped',
  );
});

test('/ready and /metrics (Lab 8)', async () => {
  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, 200);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  for (const name of [
    'flyordie_players',
    'flyordie_rooms',
    'flyordie_ws_connections',
    'flyordie_event_loop_utilization',
    'flyordie_ws_messages_in_total',
    'flyordie_ws_rejections_total',
    'flyordie_process_resident_memory_bytes',
    'flyordie_build_info',
  ])
    assert.ok(metrics.includes(name), `metric ${name}`);
  // earlier tests were rejected for bad JSON, unknown types, rate limits…: counted by reason
  assert.match(metrics, /flyordie_ws_rejections_total\{reason="bad_message"/);
  assert.match(metrics, /flyordie_ws_rejections_total\{reason="policy"/);
});

test('handshake gate: a foreign Origin gets 403, the 9th socket from one IP gets 429', async () => {
  const status = (headers: Record<string, string> = {}) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl, { headers });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close(); // a probe: don't keep the slot
        resolve(101);
      });
      ws.on('error', () => {});
    });
  assert.equal(await status({ Origin: 'https://evil.example' }), 403);
  assert.equal(await status({ Origin: base }), 101, 'same origin');
  await new Promise((r) => setTimeout(r, 100));

  const open: WebSocket[] = [];
  for (let i = 0; i < 8; i++) {
    const ws = new WebSocket(wsUrl);
    await once(ws, 'open');
    open.push(ws);
  }
  assert.equal(await status(), 429);
  for (const ws of open) ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await status(), 101, 'closing frees the slots');
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /flyordie_ws_rejections_total\{reason="origin"[^}]*\} 1/);
  assert.match(metrics, /flyordie_ws_rejections_total\{reason="ip_cap"[^}]*\} 1/);
});

const ReplaysSchema = z.object({
  replays: z.array(z.object({ id: z.string(), bytes: z.number(), modified: z.string() })),
});
const LogLine = z.object({ type: z.string() });

test('a finished match is in the log directory and streams back from /api/replays', async () => {
  const files = (await readdir(logDir)).filter((f) => f.startsWith('eu-1-'));
  assert.ok(files.length >= 1, 'eu-1 match log exists');
  const { replays } = await getJson(`${base}/api/replays`, ReplaysSchema);
  const replay = replays.find((r) => r.id.startsWith('eu-1-'));
  assert.ok(replay);
  const res = await fetch(`${base}/api/replays/${replay.id}`);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const types = (await res.text())
    .trim()
    .split('\n')
    .map((l) => LogLine.parse(JSON.parse(l)).type);
  assert.equal(types[0], 'match_start');
  assert.ok(types.includes('chat'));
  assert.equal(types.at(-1), 'match_end');
  assert.equal((await fetch(`${base}/api/replays/..%2f..%2fpackage`)).status, 400);
});
