// README asset (Lab 8): the live dashboard during a bot match → docs/lab-08/dashboard.png
//   npm run build && node scripts/screenshot-dashboard.ts
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { encodeInputs } from '../shared/src/net/codec-binary.ts';
import { BUTTON } from '../shared/src/net/protocol.ts';
import { asSeq } from '../shared/src/ids.ts';
import { forkServer } from '../server/scripts/fork-server.ts';

const root = join(import.meta.dirname, '..');
const server = await forkServer({
  NODE_ENV: 'production',
  LOG_LEVEL: 'warn',
  GIT_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  LOG_DIR: await mkdtemp(join(tmpdir(), 'fod-dash-')),
});
const post = (room: string, count: number) =>
  fetch(`${server.base}/api/rooms/${room}/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
  });
await post('eu-1', 6);
await post('eu-2', 6);

// 8 real WebSocket pilots (2 + 2 + 4), binary inputs at 30 Hz — so messages and bytes move too.
const pilots: WebSocket[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
for (const [i, room] of [
  'eu-1',
  'eu-1',
  'eu-2',
  'eu-2',
  'us-1',
  'us-1',
  'us-1',
  'us-1',
].entries()) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ v: 1, type: 'join', room, name: `Pilot${i}`, codec: 'binary' }));
  let seq = 0;
  timers.push(
    setInterval(() => {
      seq++;
      const buttons =
        BUTTON.thrust | (seq % 80 < 30 ? BUTTON.left : 0) | (seq % 20 < 4 ? BUTTON.fire : 0);
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeInputs([{ seq: asSeq(seq), buttons }]));
    }, 1000 / 30),
  );
  pilots.push(ws);
}
const browser = await chromium.launch({
  channel: process.env.CI ? undefined : 'msedge',
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1180, height: 560 },
  deviceScaleFactor: 1,
});
await page.goto(`${server.base}/dashboard.html`);
await page.waitForTimeout(14_000); // sparklines fill up
await mkdir(join(root, 'docs', 'lab-08'), { recursive: true });
await page.screenshot({ path: join(root, 'docs', 'lab-08', 'dashboard.png') });
await browser.close();
for (const t of timers) clearInterval(t);
for (const ws of pilots) ws.close();
await post('eu-1', 0);
await post('eu-2', 0);
console.log('exit', await server.stop(), '→ docs/lab-08/dashboard.png');
