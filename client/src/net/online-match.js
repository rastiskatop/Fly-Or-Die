import { createLoop } from '../loop.js';
import { drawWorld } from '../render/draw.js';
import { createBattlefield } from '../render/battlefield.js';
import { createHud } from '../render/hud.js';
import { attachAudio } from '../audio/audio.js';
import { showChat } from './chat-view.js';
import { NetGame } from './netgame.js';
import { drawNetgraph } from './netgraph.js';
import { DT, controlsToButtons } from '@flyordie/shared/net/protocol.js';
import { physics } from '@flyordie/shared/sim/ship.js';
import { botButtons } from '@flyordie/shared/bot.js';

// Latency presets for the netsim hotkeys 1–4 (Lab 5: "you cannot develop netcode on localhost").
const PRESETS = [
  { lagMs: 0, jitterMs: 0, dropPct: 0 },
  { lagMs: 100, jitterMs: 30, dropPct: 2 },
  { lagMs: 200, jitterMs: 50, dropPct: 5 },
  { lagMs: 300, jitterMs: 100, dropPct: 10 },
];

/** URL switches for netcode experiments: ?lag=100&jitter=30&drop=2&codec=json&chaos=1&autopilot=1 … */
export function readNetFlags(search = location.search) {
  const q = new URLSearchParams(search);
  const num = (k, d) => (q.has(k) ? Number(q.get(k)) || 0 : d);
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
}) {
  const match = new AbortController();
  const { signal } = match;
  const on = (type, fn) => conn.addEventListener(type, (e) => fn(e.detail), { signal });

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

  on('binary', (data) => net.receive(data));
  on('snapshot', (msg) => net.receive(JSON.stringify(msg))); // JSON codec path
  on('roster', ({ players }) => net.setRoster(players));
  on('welcome', ({ playerId }) => {
    // after an automatic reconnect we are a new player with a new ship
    net.selfPlayerId = playerId;
    net.me = null;
    net.pending = [];
    if (netsim.lagMs || netsim.jitterMs || netsim.dropPct) sendNetsim();
  });
  on('pong', ({ t }) => {
    net.stats.rttMs = performance.now() - t;
  });

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

  attachAudio(net.bus, audio, { signal });
  const hud = createHud(net.bus, { playerId: () => net.selfShipId, signal });
  showChat(document.getElementById('chat'), conn, { selfId: () => conn.selfId, signal });
  const battlefield = createBattlefield(bounds.width, bounds.height, {
    terrain: arena.terrain,
    seed: arena.seed,
  });

  // Netcode hotkeys
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.target !== document.body) return;
      const preset = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 }[e.code];
      if (preset !== undefined) {
        netsim = { ...PRESETS[preset] };
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
  function simulate() {
    stepCount++;
    let buttons;
    if (flags.autopilot) {
      const me = net.me;
      const targets = [];
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
  }

  let lastFrame = performance.now();
  function render(alpha) {
    const now = performance.now();
    const frameDt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    net.flushEvents(now);
    battlefield.draw(ctx, now / 1000, frameDt);
    drawWorld(ctx, net.renderWorld(now, frameDt), alpha, now / 1000, assets.sprites);
    const player = net.selfView();
    if (player) {
      hud.draw(ctx, { stats: loop.getStats(), player, ...bounds, room: room.name, audio });
    } else {
      ctx.fillStyle = '#e8dcb5';
      ctx.font = '20px "Russo One", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for the first snapshot…', bounds.width / 2, bounds.height / 2);
    }
    if (showGraph) drawNetgraph(ctx, net, { netsim, fps: loop.getStats().fps });
  }

  const loop = createLoop({ step: DT, simulate, render });
  setMenuMode(false);
  loop.start();
  window.net = net; // console access for the defense (net.stats, net.pending, …)

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
