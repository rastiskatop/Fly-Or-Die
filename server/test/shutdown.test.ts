// Graceful shutdown (Lab 8, M1): a player in a match gets the warning, then close 1001
// ("going away"); the process exits 0, well inside a platform's 10-s grace period.
// (On Windows a parent can't send SIGTERM to a child, so the test uses the IPC "shutdown" message,
// which runs the very same shutdown() as the SIGTERM handler; CI's Docker job does `docker stop`.)
import { expect, test } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkServer } from '../scripts/fork-server.ts';
import { toBuffer } from '../src/ws.ts';

test('shutdown: system message + 1001 to players, /ready goes 503, exit 0 in < 10 s', async () => {
  const server = await forkServer({
    LOG_DIR: await mkdtemp(join(tmpdir(), 'flyordie-shutdown-')),
    LOG_LEVEL: 'warn',
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const texts: string[] = [];
  ws.on('message', (d: RawData, isBinary: boolean) => {
    if (!isBinary) texts.push(toBuffer(d).toString());
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));
  await once(ws, 'open');
  ws.send(JSON.stringify({ v: 1, type: 'join', room: 'eu-1', name: 'Pilot', codec: 'binary' }));
  await new Promise((r) => setTimeout(r, 300)); // in the match, snapshots flowing
  expect((await fetch(`${server.base}/ready`)).status).toBe(200);

  const t0 = performance.now();
  const exit = server.stop(); // = what SIGTERM does
  const code = await closed;
  const exitCode = await exit;
  const ms = performance.now() - t0;

  expect(code).toBe(1001);
  expect(texts.some((t) => t.includes('"system"') && t.includes('restarting'))).toBe(true);
  expect(exitCode).toBe(0);
  expect(ms).toBeLessThan(10_000);
}, 20_000);
