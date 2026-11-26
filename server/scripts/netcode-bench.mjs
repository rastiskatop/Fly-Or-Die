// Lab 5 measurements with HEADLESS CLIENTS that run the real browser netcode (client/src/net/
// connection.js + netgame.js) in Node — Node ≥ 22 has a WHATWG WebSocket, EventTarget, CustomEvent.
//   node scripts/netcode-bench.mjs
// Prints: JSON vs binary bytes per snapshot / KB/s per client, encode+decode µs, reconciliation
// corrections at 100 ms ±30 / 2% drop (normal vs Math.random in the client's physics), server tick
// stats, and setInterval vs absolute-target timer jitter.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { Connection } from '../../client/src/net/connection.js';
import { NetGame } from '../../client/src/net/netgame.js';
import { botButtons } from '@flyordie/shared/bot.js';
import { physics } from '@flyordie/shared/sim/ship.js';
import { bounds } from '@flyordie/shared/sim/arena.js';
import {
  DT,
  TICK_RATE,
  snapshotEntities,
  collectEvents,
  buttonsToControls,
} from '@flyordie/shared/net/protocol.js';
import { createMatchWorld, spawnPlayerShip } from '@flyordie/shared/sim/game.js';
import * as binary from '@flyordie/shared/net/codec-binary.js';
import * as json from '@flyordie/shared/net/codec-json.js';

const BOTS = 4;
const SECONDS = Number(process.env.SECONDS ?? 12);

async function startServer() {
  const child = fork(join(import.meta.dirname, '..', 'src', 'index.js'), [], {
    env: { ...process.env, PORT: '0', LOG_DIR: join(import.meta.dirname, '..', 'logs', 'bench') },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const [{ port }] = await once(child, 'message');
  return { child, port };
}

async function bot(port, room, name, codec, netsim) {
  const conn = new Connection(`ws://127.0.0.1:${port}/ws`);
  conn.addEventListener('open', () => conn.sendNow({ type: 'join', room, name, codec }));
  const welcome = new Promise((resolve) =>
    conn.addEventListener('welcome', (e) => resolve(e.detail), { once: true }),
  );
  conn.connect();
  const { playerId } = await welcome;
  conn.markReady();
  const net = new NetGame({ conn, codec, bounds, selfPlayerId: playerId });
  conn.addEventListener('binary', (e) => net.receive(e.detail));
  conn.addEventListener('snapshot', (e) => net.receive(JSON.stringify(e.detail)));
  conn.addEventListener('roster', (e) => net.setRoster(e.detail.players));
  conn.addEventListener('pong', (e) => (net.stats.rttMs = performance.now() - e.detail.t));
  if (netsim) conn.send({ type: 'netsim', ...netsim });
  return { conn, net, name };
}

/** Runs BOTS headless pilots for SECONDS at 30 Hz (absolute-target timer), returns measurements. */
async function scenario({ codec, netsim = null, chaos = false, room }) {
  const { child, port } = await startServer();
  const bots = [];
  for (let i = 0; i < BOTS; i++) bots.push(await bot(port, room, `bot${i}`, codec, netsim));
  physics.chaos = chaos;

  await new Promise((r) => setTimeout(r, 1000)); // warm-up: queues and clocks settle
  for (const b of bots) {
    b.in0 = b.conn.bytesIn;
    b.out0 = b.conn.bytesOut;
    b.snap0 = b.net.stats.serverTick;
    b.net.history.correction.length = 0;
  }

  let step = 0;
  let next = performance.now();
  const t0 = performance.now();
  const ping = setInterval(
    () => bots.forEach((b) => b.conn.send({ type: 'ping', t: performance.now() })),
    500,
  );
  await new Promise((resolve) => {
    const tick = () => {
      step++;
      for (const b of bots) {
        const me = b.net.me;
        const targets = (b.net.latest?.entities ?? []).filter(
          (e) => e.kind === 'asteroid' || (e.kind === 'ship' && e.id !== b.net.selfShipId),
        );
        b.net.step(
          botButtons(
            me && { x: me.pos.x, y: me.pos.y, angle: me.angle },
            targets,
            step + b.name.length * 7,
          ),
        );
      }
      if (performance.now() - t0 > SECONDS * 1000) return resolve();
      next += 1000 / TICK_RATE;
      setTimeout(tick, Math.max(0, next - performance.now()));
    };
    tick();
  });
  clearInterval(ping);
  physics.chaos = false;

  const secs = (performance.now() - t0) / 1000;
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
  const per = bots.map((b) => {
    const snaps = b.net.stats.serverTick - b.snap0;
    const corr = b.net.history.correction;
    const sorted = [...corr].sort((x, y) => x - y);
    return {
      downKBs: (b.conn.bytesIn - b.in0) / 1024 / secs,
      upKBs: (b.conn.bytesOut - b.out0) / 1024 / secs,
      bytesPerSnapshot: (b.conn.bytesIn - b.in0) / Math.max(1, snaps),
      corrMean: corr.reduce((s, v) => s + v, 0) / Math.max(1, corr.length),
      corrP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      corrZero: corr.filter((v) => v < 0.01).length / Math.max(1, corr.length),
      rtt: b.net.stats.rttMs,
      pending: b.net.pending.length,
    };
  });
  for (const b of bots) b.conn.close();
  child.send({ type: 'shutdown' });
  await once(child, 'exit');
  const avg = (k) => per.reduce((s, p) => s + p[k], 0) / per.length;
  return {
    downKBs: avg('downKBs'),
    upKBs: avg('upKBs'),
    bytesPerSnapshot: avg('bytesPerSnapshot'),
    corrMean: avg('corrMean'),
    corrP95: avg('corrP95'),
    corrZero: avg('corrZero'),
    rtt: avg('rtt'),
    pending: avg('pending'),
    match: stats.matches[0],
  };
}

function codecMicrobench() {
  const world = createMatchWorld({ ...bounds });
  const events = collectEvents(world);
  const ships = [0, 1, 2, 3].map((i) => spawnPlayerShip(world, `P${i}`));
  for (let i = 0; i < 120; i++)
    world.step(DT, new Map(ships.map((s, k) => [s.id, buttonsToControls((i + k) % 3 ? 12 : 5)])));
  const snap = {
    tick: world.tick,
    ack: 12345,
    entities: snapshotEntities(world),
    events: events.slice(-6),
  };
  const time = (fn) => {
    for (let i = 0; i < 2000; i++) fn(); // JIT warm-up
    const n = 20000;
    const t = performance.now();
    for (let i = 0; i < n; i++) fn();
    return ((performance.now() - t) * 1000) / n;
  };
  return {
    entities: snap.entities.length,
    jsonUs: time(() => json.decodeSnapshot(json.encodeSnapshot(snap))),
    binaryUs: time(() => binary.decodeSnapshot(binary.encodeSnapshot(snap))),
  };
}

async function timerJitter() {
  const measure = (useInterval) =>
    new Promise((resolve) => {
      const times = [];
      const start = performance.now();
      if (useInterval) {
        const id = setInterval(() => {
          times.push(performance.now());
          if (times.length >= 150) {
            clearInterval(id);
            resolve(times);
          }
        }, 33);
      } else {
        let next = start + 1000 / 30;
        const tick = () => {
          times.push(performance.now());
          if (times.length >= 150) return resolve(times);
          next += 1000 / 30;
          setTimeout(tick, Math.max(0, next - performance.now()));
        };
        setTimeout(tick, next - start);
      }
    });
  const summarize = (times) => {
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const dev = gaps.reduce((s, g) => s + Math.abs(g - 1000 / 30), 0) / gaps.length;
    return { hz: 1000 / mean, meanGap: mean, meanAbsDev: dev, maxGap: Math.max(...gaps) };
  };
  return { setInterval: summarize(await measure(true)), absolute: summarize(await measure(false)) };
}

const f = (n, d = 1) => n.toFixed(d);
console.log(`\n${BOTS} headless clients, ${SECONDS} s each, 30 Hz\n`);

const mb = codecMicrobench();
const jsonRun = await scenario({ codec: 'json', room: 'eu-1' });
const binRun = await scenario({ codec: 'binary', room: 'eu-1' });
console.log(
  '| Codec | Bytes/snapshot | KB/s per client (down) | KB/s per client (up) | Encode+decode µs |',
);
console.log('|---|---|---|---|---|');
console.log(
  `| JSON | ${f(jsonRun.bytesPerSnapshot, 0)} | ${f(jsonRun.downKBs)} | ${f(jsonRun.upKBs, 2)} | ${f(mb.jsonUs)} |`,
);
console.log(
  `| Binary (\`DataView\`) | ${f(binRun.bytesPerSnapshot, 0)} | ${f(binRun.downKBs)} | ${f(binRun.upKBs, 2)} | ${f(mb.binaryUs)} |`,
);
console.log(`(microbench snapshot: ${mb.entities} entities)\n`);

const lag = { lagMs: 100, jitterMs: 30, dropPct: 2 };
const normal = await scenario({ codec: 'binary', netsim: lag, room: 'eu-2' });
const chaos = await scenario({ codec: 'binary', netsim: lag, chaos: true, room: 'eu-2' });
console.log('Reconciliation at 100 ms ±30, 2% drop (binary):');
console.log(
  '| Client physics | RTT ms | pending inputs | corrections = 0 | mean correction px | p95 px |',
);
console.log('|---|---|---|---|---|---|');
for (const [label, r] of [
  ['deterministic (shared stepShipMotion)', normal],
  ['Math.random() in the client only (?chaos=1)', chaos],
]) {
  console.log(
    `| ${label} | ${f(r.rtt, 0)} | ${f(r.pending, 1)} | ${f(r.corrZero * 100, 0)}% | ${f(r.corrMean, 2)} | ${f(r.corrP95, 2)} |`,
  );
}
console.log('\nServer match stats (last run):', JSON.stringify(chaos.match));

const tj = await timerJitter();
console.log('\nTimers, target 30 Hz (33.33 ms):');
for (const [k, v] of Object.entries(tj)) {
  console.log(
    `  ${k.padEnd(12)} ${f(v.hz, 2)} Hz · mean gap ${f(v.meanGap, 2)} ms · mean |gap − 33.33| ${f(v.meanAbsDev, 2)} ms · max gap ${f(v.maxGap, 1)} ms`,
  );
}
