import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { bounds } from '@flyordie/shared/sim/arena.js';
import { createGame, DEFAULT_ARENA } from '@flyordie/shared/sim/game.js';
import { setupCanvas } from './render/canvas.js';
import { drawWorld } from './render/draw.js';
import { createBattlefield } from './render/battlefield.js';
import { createMenuBackground } from './render/menu-bg.js';
import { createHud } from './render/hud.js';
import { createSprites } from './render/sprites.js';
import { createAudio, attachAudio } from './audio/audio.js';
import { loadAll, loadJson } from './assets/loader.js';
import { withRetry } from './assets/net.js';
import {
  readDebugFlags,
  manifestUrl,
  roomsUrl,
  applyDebugFlags,
  manifestEntries,
} from './assets/debug.js';
import { IS_DEV, staticUrl, shortUrl } from './assets/base.js';
import { runLoadingScreen } from './screens/loading-screen.js';
import { Lobby } from './lobby/lobby.js';
import { showLobby } from './lobby/lobby-view.js';
import { demonstrateThisBug } from './experiments/this-bug.js';
import { runPuzzles } from './experiments/puzzles.js';
import { findServer } from './net/server.js';
import { Connection } from './net/connection.js';
import { showChat } from './net/chat-view.js';
import { playOnlineMatch, readNetFlags } from './net/online-match.js';
import { simulationHash } from '@flyordie/shared/sim/determinism.js';

const flags = readDebugFlags();
const netFlags = readNetFlags();
const { ctx } = setupCanvas('gameCanvas', bounds);
const input = createInput(window);
const audio = createAudio();
const menuBg = createMenuBackground(document.getElementById('menu-bg'));
// Menus (loading + lobby) sit on the animated war backdrop; a match hides it.
function setMenuMode(on) {
  document.body.classList.toggle('menu', on);
  if (on) menuBg.start();
  else menuBg.stop();
}
setMenuMode(true);

// Safety net: a rejection nobody handled is a bug — make it loud in the console.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
});

// The first gesture anywhere unlocks audio (Join in the lobby also does it explicitly).
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, () => audio.unlock(), { once: true });
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) {
    if (e.target === document.body) e.preventDefault();
  }
  if (e.code === 'KeyM' && e.target === document.body) audio.toggleMute();
});

// ---------- M1: manifest + assets behind a loading screen ----------
async function loadEverything({ signal, onProgress }) {
  const manifest = await withRetry(() => loadJson(manifestUrl(flags), { signal }), {
    attempts: 3,
    baseMs: 300,
    signal,
    onRetry: ({ attempt, delay, error }) =>
      console.warn(`[assets] manifest: ${error.message}, retry #${attempt} in ${delay} ms`),
  });
  // Entries in the manifest are relative to the manifest file itself → make them absolute.
  const base = staticUrl('assets/manifest.json');
  const resolved = structuredClone(manifest);
  for (const entry of manifestEntries(resolved)) entry.url = new URL(entry.url, base).href;
  return loadAll(applyDebugFlags(resolved, flags), {
    audioCtx: audio.ctx,
    onProgress,
    signal,
    sequential: flags.sequential,
  });
}

function buildAssets(loaded) {
  const sprites =
    loaded.atlas && loaded.images.sheet ? createSprites(loaded.images.sheet, loaded.atlas) : null;
  audio.setBuffers(loaded.sounds);
  const notices = loaded.failures.map((f) => {
    const what =
      f.group === 'images'
        ? 'vector graphics fallback'
        : f.group === 'sounds'
          ? 'this sound is muted'
          : 'default arena';
    return `${shortUrl(f.url)}: ${f.reason} → ${what}`;
  });
  return { sprites, arenas: loaded.arenas, notices };
}

// ---------- Lab 4: join a room on the server over WebSocket ----------
/**
 * Opens the socket, sends join, resolves on 'welcome' with the connection, rejects if the server
 * refuses (room full / not found) or the socket closes first. The 'open' → join listener stays
 * for the connection's whole life, so after an automatic reconnect we re-join the same room.
 */
function connectToRoom(server, room, name) {
  const conn = new Connection(server.wsUrl);
  conn.selfId = null;
  conn.addEventListener('open', () =>
    conn.sendNow({ type: 'join', room: room.id, name, codec: netFlags.codec }),
  );
  conn.addEventListener('welcome', (e) => {
    conn.selfId = e.detail.playerId;
    conn.markReady(); // flush chat typed while we were reconnecting
  });

  return new Promise((resolve, reject) => {
    const wait = new AbortController();
    let refusal = null;
    conn.addEventListener('error', (e) => (refusal = e.detail.message), { signal: wait.signal });
    conn.addEventListener(
      'welcome',
      (e) => {
        wait.abort();
        resolve({ conn, room: e.detail.room });
      },
      { signal: wait.signal },
    );
    conn.addEventListener(
      'status',
      (e) => {
        if (e.detail.state !== 'closed' && e.detail.state !== 'waiting') return;
        wait.abort();
        conn.close();
        reject(new Error(refusal ?? `could not connect (code ${e.detail.code ?? '?'})`));
      },
      { signal: wait.signal },
    );
    conn.connect();
  });
}

// ---------- M2: one match. Resolves when the player presses Esc. ----------
function playMatch({ room, name, assets, conn = null }) {
  const arena = assets.arenas[room.arena] ?? DEFAULT_ARENA;
  const { world, player } = createGame({
    width: bounds.width,
    height: bounds.height,
    arena,
    playerName: name,
  });
  const match = new AbortController(); // ends every subscription of this match
  attachAudio(world, audio, { signal: match.signal });
  const hud = createHud(world, { playerId: player.id, signal: match.signal });
  const battlefield = createBattlefield(bounds.width, bounds.height, {
    terrain: arena.terrain,
    seed: arena.seed,
  });
  let lastFrame = performance.now() / 1000;
  if (conn)
    showChat(document.getElementById('chat'), conn, {
      selfId: () => conn.selfId,
      signal: match.signal,
    });
  const roomLabel = conn ? room.name : `${room.name} (offline)`;

  function simulate(dt) {
    const controls = {
      left: input.isDown('KeyA') || input.isDown('ArrowLeft'),
      right: input.isDown('KeyD') || input.isDown('ArrowRight'),
      thrust: input.isDown('KeyW') || input.isDown('ArrowUp'),
      fire: input.isDown('Space'),
    };
    world.step(dt, new Map([[player.id, controls]]));
    input.consume();
  }

  function render(alpha) {
    const time = performance.now() / 1000;
    battlefield.draw(ctx, time, Math.min(0.1, time - lastFrame));
    lastFrame = time;
    drawWorld(ctx, world, alpha, time, assets.sprites);
    hud.draw(ctx, { stats: loop.getStats(), player, ...bounds, room: roomLabel, audio });
  }

  const loop = createLoop({ step: 1 / 60, simulate, render });
  setMenuMode(false);
  loop.start();

  if (IS_DEV) {
    window.game = { world, player, audio, assets };
    if (flags.demo === 'this') demonstrateThisBug(player, world);
  }

  return new Promise((resolve) => {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape') return;
        loop.stop();
        match.abort();
        setMenuMode(true);
        conn?.close(1000, 'left the match'); // server: leave → roster update for the others
        resolve();
      },
      { signal: match.signal },
    );
  });
}

// ---------- the whole app as one async flow ----------
async function main() {
  if (flags.demo === 'puzzles') await runPuzzles();
  if (flags.demo === 'determinism') {
    // Compare with `npm test -w shared` in Node: the hashes must be identical.
    console.info('[determinism] browser hash after 600 steps:', simulationHash(600));
  }

  const loaded = await runLoadingScreen(ctx, bounds, loadEverything);
  const assets = buildAssets(loaded);
  const server = await findServer(); // null → offline: static rooms, local game, no chat
  console.info(
    server ? `[net] game server at ${server.apiBase}` : '[net] no game server — offline mode',
  );
  const lobby = new Lobby({
    url: roomsUrl(flags, server?.apiBase),
    createUrl: server ? `${server.apiBase}/api/rooms` : null,
  });
  if (IS_DEV) window.lobby = lobby;

  // ?join=eu-1&name=Red — join straight away (the duel recorder and headless demos use it)
  const q = new URLSearchParams(location.search);
  let autoJoin = q.get('join') ? { room: q.get('join'), name: q.get('name') ?? 'Pilot' } : null;

  let error = null;
  for (;;) {
    if (autoJoin) {
      const target = autoJoin;
      autoJoin = null;
      lobby.addEventListener(
        'rooms',
        () => {
          try {
            lobby.join(target.room, target.name);
          } catch (err) {
            console.warn('[autojoin]', err.message);
          }
        },
        { once: true },
      );
    }
    ctx.clearRect(0, 0, bounds.width, bounds.height);
    const { room, name } = await showLobby(document.getElementById('lobby'), lobby, {
      notices: assets.notices,
      onGesture: () => audio.unlock(),
      error,
    });
    error = null;
    if (!server) {
      await playMatch({ room, name, assets });
      continue;
    }
    try {
      const joined = await connectToRoom(server, room, name);
      await playOnlineMatch({
        ctx,
        bounds,
        conn: joined.conn,
        room: joined.room,
        assets,
        input,
        audio,
        arena: assets.arenas[joined.room.arena] ?? DEFAULT_ARENA,
        flags: netFlags,
        setMenuMode,
      });
    } catch (err) {
      error = `Could not join ${room.name}: ${err.message}`;
    }
  }
}

main();
