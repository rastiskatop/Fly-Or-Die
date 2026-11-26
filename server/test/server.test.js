// Integration: starts the real server (child process, random port, temp LOG_DIR) and talks to it
// over HTTP and WebSocket like a browser would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

let child;
let base;
let wsUrl;
let logDir;

before(async () => {
  logDir = await mkdtemp(join(tmpdir(), 'flyordie-logs-'));
  child = fork(join(import.meta.dirname, '..', 'src', 'index.js'), [], {
    env: {
      ...process.env,
      PORT: '0',
      LOG_DIR: logDir,
      JOIN_TIMEOUT_MS: '300',
      RATE_LIMIT_PER_SEC: '5',
      RATE_LIMIT_BURST: '5',
      MAX_PAYLOAD_BYTES: '1024',
      MAX_PLAYERS_PER_ROOM: '2',
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const [msg] = await once(child, 'message');
  base = `http://127.0.0.1:${msg.port}`;
  wsUrl = `ws://127.0.0.1:${msg.port}/ws`;
});

after(async () => {
  child.send({ type: 'shutdown' }); // graceful: closes sockets, flushes logs, exits 0
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

/** Opens a socket and collects every parsed message. */
async function client() {
  const ws = new WebSocket(wsUrl);
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  await once(ws, 'open');
  const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
  const waitFor = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out waiting for message; got ' + JSON.stringify(messages));
  };
  return { ws, messages, send, waitFor };
}

test('GET /health and /api/rooms', async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, 'ok');
  const { rooms } = await (await fetch(`${base}/api/rooms`)).json();
  assert.ok(rooms.some((r) => r.id === 'eu-1'));
});

test('POST /api/rooms validates and caps the body', async () => {
  const ok = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test', arena: 'calm' }),
  });
  assert.equal(ok.status, 201);
  const bad = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test', arena: 'moon' }),
  });
  assert.equal(bad.status, 400);
  const huge = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(5000) }),
  });
  assert.equal(huge.status, 413);
});

test('two clients join one room, see each other, chat', async () => {
  const a = await client();
  const b = await client();
  a.send({ type: 'join', room: 'eu-1', name: 'Alice' });
  await a.waitFor((m) => m.type === 'welcome');
  b.send({ type: 'join', room: 'eu-1', name: 'Bob' });
  await b.waitFor((m) => m.type === 'welcome');

  const roster = await a.waitFor((m) => m.type === 'roster' && m.players.length === 2);
  assert.deepEqual(roster.players.map((p) => p.name).sort(), ['Alice', 'Bob']);

  b.send({ type: 'chat', text: 'hello Alice' });
  const chat = await a.waitFor((m) => m.type === 'chat');
  assert.equal(chat.from.name, 'Bob');
  assert.equal(chat.text, 'hello Alice');

  // room cap is 2 for this test server
  const c = await client();
  c.send({ type: 'join', room: 'eu-1', name: 'Carol' });
  assert.equal(await c.ws.closed, 4004);

  b.ws.close(1000);
  await a.waitFor((m) => m.type === 'roster' && m.players.length === 1);
  a.ws.close(1000);
  await a.ws.closed;
});

test('protocol violations close the socket with a code', async () => {
  const bad = await client();
  bad.ws.send('not json');
  assert.equal(await bad.ws.closed, 4000);

  const unknown = await client();
  unknown.send({ type: 'join', room: 'eu-2', name: 'X' });
  await unknown.waitFor((m) => m.type === 'welcome');
  unknown.send({ type: 'teleport', x: 1 });
  assert.equal(await unknown.ws.closed, 4001);

  const silent = await client(); // never sends join
  assert.equal(await silent.ws.closed, 4003);

  const big = await client();
  big.ws.send('x'.repeat(4096)); // over MAX_PAYLOAD_BYTES=1024
  assert.equal(await big.ws.closed, 1009);
});

test('rate limit: a flood closes the socket with 1008', async () => {
  const spam = await client();
  spam.send({ type: 'join', room: 'eu-2', name: 'Spam' });
  await spam.waitFor((m) => m.type === 'welcome');
  for (let i = 0; i < 20; i++) spam.send({ type: 'chat', text: `spam ${i}` });
  assert.equal(await spam.ws.closed, 1008);
});

test('binary netcode: inputs up, snapshots down with this client ack', async () => {
  const { encodeInputs, decodeSnapshot } = await import('@flyordie/shared/net/codec-binary.js');
  const ws = new WebSocket(wsUrl);
  const snaps = [];
  let welcome;
  ws.on('message', (data, isBinary) => {
    if (isBinary) snaps.push(decodeSnapshot(data));
    else if (JSON.parse(data).type === 'welcome') welcome = JSON.parse(data);
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ v: 1, type: 'join', room: 'us-1', name: 'Bin', codec: 'binary' }));
  for (let seq = 1; seq <= 10; seq++) {
    ws.send(encodeInputs([{ seq, buttons: 4 }])); // thrust
    await new Promise((r) => setTimeout(r, 34));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(welcome?.tickRate === 30);
  assert.ok(snaps.length >= 10, `got ${snaps.length} snapshots`);
  const last = snaps.at(-1);
  assert.equal(last.ack, 10); // every input applied exactly once, in order
  assert.ok(snaps.every((s, i) => i === 0 || s.tick > snaps[i - 1].tick));
  assert.ok(last.entities.some((e) => e.kind === 'ship'));
  ws.send(Buffer.from([1, 1, 0])); // malformed binary inputs
  const [code] = await once(ws, 'close');
  assert.equal(code, 4000);
});

test('a finished match is in the log directory and streams back from /api/replays', async () => {
  const files = (await readdir(logDir)).filter((f) => f.startsWith('eu-1-'));
  assert.ok(files.length >= 1, 'eu-1 match log exists');
  const { replays } = await (await fetch(`${base}/api/replays`)).json();
  const replay = replays.find((r) => r.id.startsWith('eu-1-'));
  const res = await fetch(`${base}/api/replays/${replay.id}`);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const types = (await res.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).type);
  assert.equal(types[0], 'match_start');
  assert.ok(types.includes('chat'));
  assert.equal(types.at(-1), 'match_end');
  assert.equal((await fetch(`${base}/api/replays/..%2f..%2fpackage`)).status, 400);
});
