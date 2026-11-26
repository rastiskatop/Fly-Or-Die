import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { bounds } from './sim/arena.js';
import { createGame, DEFAULT_ARENA } from './sim/game.js';
import { setupCanvas } from './render/canvas.js';
import { drawGrid, drawWorld } from './render/draw.js';
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

const flags = readDebugFlags();
const { ctx } = setupCanvas('gameCanvas', bounds);
const input = createInput(window);
const audio = createAudio();

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

// ---------- M2: one match. Resolves when the player presses Esc. ----------
function playMatch({ room, name, assets }) {
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
    drawGrid(ctx, bounds.width, bounds.height, arena);
    drawWorld(ctx, world, alpha, time, assets.sprites);
    hud.draw(ctx, { stats: loop.getStats(), player, ...bounds, room: room.name, audio });
  }

  const loop = createLoop({ step: 1 / 60, simulate, render });
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
        resolve();
      },
      { signal: match.signal },
    );
  });
}

// ---------- the whole app as one async flow ----------
async function main() {
  if (flags.demo === 'puzzles') await runPuzzles();

  const loaded = await runLoadingScreen(ctx, bounds, loadEverything);
  const assets = buildAssets(loaded);
  const lobby = new Lobby({ url: roomsUrl(flags) });
  if (IS_DEV) window.lobby = lobby;

  for (;;) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, bounds.width, bounds.height);
    const { room, name } = await showLobby(document.getElementById('lobby'), lobby, {
      notices: assets.notices,
      onGesture: () => audio.unlock(),
    });
    await playMatch({ room, name, assets });
  }
}

main();
