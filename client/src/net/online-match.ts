import { createLoop } from '../loop.ts';
import { drawWorld } from '../render/draw.ts';
import { createBattlefield } from '../render/battlefield.ts';
import { createHud } from '../render/hud.ts';
import { attachAudio } from '../audio/audio.ts';
import { showChat } from './chat-view.ts';
import { NetGame } from './netgame.ts';
import { drawNetgraph } from './netgraph.ts';
import { DT, controlsToButtons } from '@flyordie/shared/net/protocol.ts';
import { physics } from '@flyordie/shared/sim/ship.ts';
import { botButtons } from '@flyordie/shared/bot.ts';
import type { ArenaRules } from '@flyordie/shared/sim/arena.ts';
import type { Bounds } from '@flyordie/shared/sim/ship.ts';
import type { CodecName, RoomInfo } from '@flyordie/shared/net/messages.ts';
import type { Connection } from './connection.ts';
import type { NetSimSettings } from './netgraph.ts';
import type { Input } from '../input.ts';
import type { Audio } from '../audio/audio.ts';
import type { Sprites } from '../render/sprites.ts';
import { el } from '../lobby/lobby-view.ts';
import { perf, perfExposed } from '../perf.ts';

// Latency presets for the netsim hotkeys 1–4 (Lab 5: "you cannot develop netcode on localhost").
const PRESETS: readonly NetSimSettings[] = [
  { lagMs: 0, jitterMs: 0, dropPct: 0 },
  { lagMs: 100, jitterMs: 30, dropPct: 2 },
  { lagMs: 200, jitterMs: 50, dropPct: 5 },
  { lagMs: 300, jitterMs: 100, dropPct: 10 },
];

/** URL switches for netcode experiments: ?lag=100&jitter=30&drop=2&codec=json&chaos=1&autopilot=1 … */
export interface NetFlags {
  readonly codec: CodecName;
  readonly netsim: NetSimSettings;
  readonly prediction: boolean;
  readonly interpolation: boolean;
  readonly interpDelayMs: number;
  readonly chaos: boolean;
  readonly autopilot: boolean;
  readonly netgraph: boolean;
}

export function readNetFlags(search = location.search): NetFlags {
  const q = new URLSearchParams(search);
  const num = (k: string, d: number): number => (q.has(k) ? Number(q.get(k)) || 0 : d);
  return {
    codec: q.get('codec') === 'json' ? 'json' : 'binary',
    netsim: { lagMs: num('lag', 0), jitterMs: num('jitter', 0), dropPct: num('drop', 0) },
    prediction: q.get('predict') !== '0',
    interpolation: q.get('interp') !== '0',
    interpDelayMs: num('delay', 100),
    chaos: q.get('chaos') === '1',
    autopilot: q.get('autopilot') === '1',
    netgraph: q.get('netgraph') !== '0',
  };
}

/**
 * One online match against the authoritative server. Resolves when the player presses Esc.
 * The client runs its fixed loop at the server's tick rate: one step = one input = DT.
 */
export function playOnlineMatch({
  ctx,
  bounds,
  conn,
  room,
  assets,
  input,
  audio,
  arena,
  flags,
  setMenuMode,
}: {
  ctx: CanvasRenderingContext2D;
  bounds: Bounds;
  conn: Connection;
  room: RoomInfo;
  assets: { readonly sprites: Sprites | null };
  input: Input;
  audio: Audio;
  arena: ArenaRules;
  flags: NetFlags;
  setMenuMode: (on: boolean) => void;
}): Promise<void> {
  const match = new AbortController();
  const { signal } = match;

  const net = new NetGame({
    conn,
    codec: flags.codec,
    bounds,
    selfPlayerId: conn.selfId,
    flags,
  });
  physics.chaos = flags.chaos;
  net.chaos = flags.chaos;
  let netsim = { ...flags.netsim };
  let showGraph = flags.netgraph;
  const sendNetsim = () => conn.send({ type: 'netsim', ...netsim });
  if (netsim.lagMs || netsim.jitterMs || netsim.dropPct) sendNetsim();

  conn.on('binary', (data) => net.receiveBinary(data), { signal });
  conn.on('snapshot', (msg) => net.receive(msg), { signal }); // JSON codec path — already validated by zod
  conn.on('roster', ({ players }) => net.setRoster(players), { signal });
  conn.on(
    'welcome',
    ({ playerId }) => {
      // after an automatic reconnect we are a new player with a new ship
      net.selfPlayerId = playerId;
      net.me = null;
      net.pending = [];
      if (netsim.lagMs || netsim.jitterMs || netsim.dropPct) sendNetsim();
    },
    { signal },
  );
  conn.on(
    'pong',
    ({ t }) => {
      net.stats.rttMs = performance.now() - t;
    },
    { signal },
  );

  // RTT probe + bytes/s, independent of the frame rate
  let lastIn = conn.bytesIn;
  let lastOut = conn.bytesOut;
  const probe = setInterval(() => conn.send({ type: 'ping', t: performance.now() }), 500);
  const meter = setInterval(() => {
    net.stats.bytesInPerS = (conn.bytesIn - lastIn) / 1024;
    net.stats.bytesOutPerS = (conn.bytesOut - lastOut) / 1024;
    lastIn = conn.bytesIn;
    lastOut = conn.bytesOut;
  }, 1000);
  signal.addEventListener('abort', () => {
    clearInterval(probe);
    clearInterval(meter);
  });

  attachAudio(net.events, bounds.width, audio, { signal });
  const hud = createHud(net.events, { playerId: () => net.selfShipId, signal });
  showChat(el(document, '#chat', HTMLElement), conn, { selfId: () => conn.selfId, signal });
  const battlefield = createBattlefield(bounds.width, bounds.height, {
    terrain: arena.terrain,
    seed: arena.seed,
  });

  // Netcode hotkeys
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.target !== document.body) return;
      const preset = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      const settings = PRESETS[preset];
      if (settings) {
        netsim = { ...settings };
        sendNetsim();
      } else if (e.code === 'KeyP') net.prediction = !net.prediction;
      else if (e.code === 'KeyI') net.interpolation = !net.interpolation;
      else if (e.code === 'BracketLeft') net.interpDelayMs = Math.max(0, net.interpDelayMs - 17);
      else if (e.code === 'BracketRight') net.interpDelayMs = Math.min(400, net.interpDelayMs + 17);
      // e.code is the physical key: N works on an English or a Cyrillic layout alike
      else if (e.code === 'KeyN') showGraph = !showGraph;
      else if (e.code === 'KeyC') physics.chaos = net.chaos = !net.chaos;
    },
    { signal },
  );

  let stepCount = 0;
  function simulate(): void {
    perf.begin('simulate');
    stepCount++;
    let buttons: number;
    if (flags.autopilot) {
      const me = net.me;
      const targets: { x: number; y: number }[] = [];
      for (const s of net.latest?.entities ?? []) {
        if (
          (s.kind === 'asteroid' ||
            (s.kind === 'ship' && s.id !== net.selfShipId && !s.destroyed)) &&
          me
        )
          targets.push(s);
      }
      buttons = botButtons(me && { x: me.pos.x, y: me.pos.y, angle: me.angle }, targets, stepCount);
    } else {
      buttons = controlsToButtons({
        left: input.isDown('KeyA') || input.isDown('ArrowLeft'),
        right: input.isDown('KeyD') || input.isDown('ArrowRight'),
        thrust: input.isDown('KeyW') || input.isDown('ArrowUp'),
        fire: input.isDown('Space'),
      });
    }
    net.step(buttons);
    net.sample(performance.now());
    input.consume();
    perf.end('simulate');
  }

  let lastFrame = performance.now();
  function render(alpha: number): void {
    perf.begin('render');
    const now = performance.now();
    const frameDt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    net.flushEvents(now);
    battlefield.draw(ctx, now / 1000, frameDt);
    drawWorld(ctx, net.renderWorld(now, frameDt), alpha, now / 1000, assets.sprites);
    const player = net.selfView();
    if (player) {
      hud.draw(ctx, {
        stats: loop.getStats(),
        player,
        ...bounds,
        room: room.name,
        audio,
        entities: net.entityCount,
      });
    } else {
      ctx.fillStyle = '#e8dcb5';
      ctx.font = '20px "Russo One", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for the first snapshot…', bounds.width / 2, bounds.height / 2);
    }
    if (showGraph) drawNetgraph(ctx, net, { netsim, fps: loop.getStats().fps });
    perf.end('render');
  }

  const loop = createLoop({ step: DT, simulate, render, onFrame: (ms) => perf.frame(ms) });
  setMenuMode(false);
  loop.start();
  if (import.meta.env.DEV) window.net = net; // console access for the defense (net.stats, net.pending, …)
  if (perfExposed) window.perf = perf; // ?perf=1: the Lab 7 profiler script reads perf.report()

  return new Promise((resolve) => {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape') return;
        loop.stop();
        match.abort();
        physics.chaos = false;
        setMenuMode(true);
        conn.close(1000, 'left the match');
        resolve();
      },
      { signal },
    );
  });
}
