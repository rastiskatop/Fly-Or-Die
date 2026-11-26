// Dev tool (Lab 5, M3), page: duel.html. TWO independent clients — two WebSocket connections, two
// NetGames with their own prediction/interpolation — flying against each other on autopilot at
// 100 ms ±30 / 2% drop, drawn side by side. Stepping and drawing are timer-driven (not
// requestAnimationFrame), so it records smoothly even in a background tab. Saves
// docs/lab-05/duel.gif via the dev server.   http://localhost:5173/duel.html  (?record=0 to watch)
import { Connection } from '../net/connection.ts';
import { NetGame } from '../net/netgame.ts';
import { findServer, type ServerLocation } from '../net/server.ts';
import { drawWorld } from '../render/draw.ts';
import { createBattlefield, type Battlefield } from '../render/battlefield.ts';
import { AtlasSchema, createSprites } from '../render/sprites.ts';
import { createHud, type Hud } from '../render/hud.ts';
import { drawNetgraph, type NetSimSettings } from '../net/netgraph.ts';
import { loadImage, loadJson } from '../assets/loader.ts';
import { staticUrl } from '../assets/base.ts';
import { el } from '../lobby/lobby-view.ts';
import { encodeGif } from './gif.ts';
import { botButtons } from '@flyordie/shared/bot.ts';
import { bounds, ArenaSchema } from '@flyordie/shared/sim/arena.ts';
import { TICK_RATE } from '@flyordie/shared/net/protocol.ts';

const NETSIM: NetSimSettings = { lagMs: 100, jitterMs: 30, dropPct: 2 };
const FPS = 10;
const SECONDS = 12;
const FW = 440;
const FH = 248;
const status = el(document, '#status', HTMLElement);

interface DuelClient {
  readonly name: string;
  readonly net: NetGame;
  readonly ctx: CanvasRenderingContext2D;
  readonly canvas: HTMLCanvasElement;
  readonly hud: Hud;
  readonly battlefield: Battlefield;
  last: number;
}

function context2d(
  canvas: HTMLCanvasElement,
  options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', options);
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
}

const [sheet, atlas, arena] = await Promise.all([
  loadImage(staticUrl('assets/sprites/sheet.svg')),
  loadJson(staticUrl('assets/sprites/sheet.json'), AtlasSchema),
  loadJson(staticUrl('assets/arenas/classic.json'), ArenaSchema),
]);
const sprites = createSprites(sheet, atlas);
const found = await findServer();
if (!found) throw new Error('start the server: npm run dev');
const server: ServerLocation = found;

async function client(canvasId: string, name: string): Promise<DuelClient> {
  const canvas = el(document, `#${canvasId}`, HTMLCanvasElement);
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const conn = new Connection(server.wsUrl);
  conn.on('open', () => conn.sendNow({ type: 'join', room: 'eu-1', name, codec: 'binary' }));
  const welcome = new Promise<string>((resolve) => {
    const off = conn.on('welcome', (m) => {
      off();
      resolve(m.playerId);
    });
  });
  conn.connect();
  const playerId = await welcome;
  conn.markReady();
  const net = new NetGame({ conn, codec: 'binary', bounds, selfPlayerId: playerId });
  conn.on('binary', (data) => net.receiveBinary(data));
  conn.on('roster', ({ players }) => net.setRoster(players));
  conn.on('pong', ({ t }) => (net.stats.rttMs = performance.now() - t));
  conn.send({ type: 'netsim', ...NETSIM });
  let lastIn = 0;
  let lastOut = 0;
  setInterval(() => {
    conn.send({ type: 'ping', t: performance.now() });
    net.stats.bytesInPerS = (conn.bytesIn - lastIn) / 1024 / 0.5;
    net.stats.bytesOutPerS = (conn.bytesOut - lastOut) / 1024 / 0.5;
    lastIn = conn.bytesIn;
    lastOut = conn.bytesOut;
  }, 500);
  return {
    name,
    net,
    ctx: context2d(canvas),
    canvas,
    hud: createHud(net.events, { playerId: () => net.selfShipId }),
    battlefield: createBattlefield(bounds.width, bounds.height, {
      terrain: arena.terrain,
      seed: arena.seed,
    }),
    last: performance.now(),
  };
}
const clients = [await client('a', 'Red'), await client('b', 'Blue')] as const;

// 30 Hz input/prediction steps on an absolute-target timer (like the server's tick).
let step = 0;
let next = performance.now();
(function tick(): void {
  step++;
  for (const c of clients) {
    const me = c.net.me;
    const others = (c.net.latest?.entities ?? []).filter(
      (e) =>
        (e.kind === 'ship' && e.id !== c.net.selfShipId && !e.destroyed) || e.kind === 'asteroid',
    );
    c.net.step(
      botButtons(
        me && { x: me.pos.x, y: me.pos.y, angle: me.angle },
        others,
        step + c.name.length * 11,
      ),
    );
    c.net.sample(performance.now());
  }
  next += 1000 / TICK_RATE;
  setTimeout(tick, Math.max(0, next - performance.now()));
})();

function draw(c: DuelClient): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - c.last) / 1000);
  c.last = now;
  c.net.flushEvents(now);
  c.battlefield.draw(c.ctx, now / 1000, dt);
  drawWorld(c.ctx, c.net.renderWorld(now, dt), 1, now / 1000, sprites);
  const player = c.net.selfView();
  if (player) {
    c.hud.draw(c.ctx, {
      stats: { fps: FPS, ups: TICK_RATE, frameTime: 1000 / FPS },
      player,
      ...bounds,
      room: 'Kyiv Dogfight',
      audio: { muted: true, state: 'unsupported' },
      entities: c.net.entityCount,
    });
  }
  drawNetgraph(c.ctx, c.net, { netsim: NETSIM, fps: FPS });
}

await new Promise((r) => setTimeout(r, 2500)); // first snapshots, clocks settle
const record = new URLSearchParams(location.search).get('record') !== '0';
const comp = document.createElement('canvas');
comp.width = FW * 2 + 6;
comp.height = FH;
const g = context2d(comp, { willReadFrequently: true });
const frames: ImageData[] = [];
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    clients.forEach(draw);
    if (!record) {
      status.textContent = 'watching (no recording)';
      return;
    }
    g.fillStyle = '#1a1712';
    g.fillRect(0, 0, comp.width, comp.height);
    g.drawImage(clients[0].canvas, 0, 0, FW, FH);
    g.drawImage(clients[1].canvas, FW + 6, 0, FW, FH);
    frames.push(g.getImageData(0, 0, comp.width, comp.height));
    status.textContent = `recording ${frames.length}/${FPS * SECONDS}`;
    if (frames.length >= FPS * SECONDS) {
      clearInterval(timer);
      resolve();
    }
  }, 1000 / FPS);
});
status.textContent = 'encoding GIF…';
await new Promise((r) => setTimeout(r, 30));
const gif = encodeGif(frames, comp.width, comp.height, Math.round(100 / FPS));
const res = await fetch('/__save/lab-05/duel.gif', { method: 'POST', body: gif });
status.textContent = `${(gif.length / 1024 / 1024).toFixed(1)} MB — ${await res.text()}`;
window.duelDone = true;
