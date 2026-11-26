import { createLoop } from './loop.ts';
import { createInput } from './input.ts';
import { bounds } from '@flyordie/shared/sim/arena.ts';
import { createGame, DEFAULT_ARENA } from '@flyordie/shared/sim/game.ts';
import { simulationHash } from '@flyordie/shared/sim/determinism.ts';
import type { ArenaRules } from '@flyordie/shared/sim/arena.ts';
import type { RoomInfo } from '@flyordie/shared/net/messages.ts';
import { setupCanvas } from './render/canvas.ts';
import { drawWorld } from './render/draw.ts';
import { createWorldView } from './render/world-view.ts';
import { createBattlefield } from './render/battlefield.ts';
import { createMenuBackground } from './render/menu-bg.ts';
import { createHud } from './render/hud.ts';
import { createSprites, type Sprites } from './render/sprites.ts';
import { createAudio, attachAudio } from './audio/audio.ts';
import {
  loadAll,
  loadJson,
  ManifestSchema,
  type LoadedAssets,
  type Progress,
} from './assets/loader.ts';
import { withRetry } from './assets/net.ts';
import {
  readDebugFlags,
  manifestUrl,
  roomsUrl,
  applyDebugFlags,
  manifestEntries,
} from './assets/debug.ts';
import { IS_DEV, staticUrl, shortUrl } from './assets/base.ts';
import { runLoadingScreen } from './screens/loading-screen.ts';
import { Lobby } from './lobby/lobby.ts';
import { showLobby, el } from './lobby/lobby-view.ts';
import { demonstrateThisBug } from './experiments/this-bug.ts';
import { runPuzzles } from './experiments/puzzles.ts';
import { findServer, type ServerLocation } from './net/server.ts';
import { Connection } from './net/connection.ts';
import { playOnlineMatch, readNetFlags } from './net/online-match.ts';

const flags = readDebugFlags();
const netFlags = readNetFlags();
const { ctx } = setupCanvas('gameCanvas', bounds);
const input = createInput(window);
const audio = createAudio({ enabled: new URLSearchParams(location.search).get('sound') !== '0' });
const menuBg = createMenuBackground(el(document, '#menu-bg', HTMLCanvasElement));

// Menus (loading + lobby) sit on the animated war backdrop; a match hides it.
function setMenuMode(on: boolean): void {
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
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => void audio.unlock(), { once: true });
}

window.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.code.startsWith('Arrow')) && e.target === document.body)
    e.preventDefault();
  if (e.code === 'KeyM' && e.target === document.body) audio.toggleMute();
});

/** Everything a match needs from the loading screen. */
interface GameAssets {
  readonly sprites: Sprites | null;
  readonly arenas: Readonly<Record<string, ArenaRules>>;
  readonly notices: readonly string[];
}

// ---------- M1 (Lab 3): manifest + assets behind a loading screen ----------
async function loadEverything({
  signal,
  onProgress,
}: {
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
}): Promise<LoadedAssets> {
  const manifest = await withRetry(() => loadJson(manifestUrl(flags), ManifestSchema, { signal }), {
    attempts: 3,
    baseMs: 300,
    signal,
    onRetry: ({ attempt, delay, error }) =>
      console.warn(
        `[assets] manifest: ${error instanceof Error ? error.message : String(error)}, retry #${attempt} in ${delay} ms`,
      ),
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

function buildAssets(loaded: LoadedAssets): GameAssets {
  const sheet = loaded.images.sheet;
  const sprites = loaded.atlas && sheet ? createSprites(sheet, loaded.atlas) : null;
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

// ---------- Lab 4/5: join a room on the server over WebSocket ----------
/**
 * Opens the socket, sends join, resolves on 'welcome', rejects if the server refuses
 * (room full / not found) or the socket closes first. The 'open' → join listener lives as long
 * as the connection, so after an automatic reconnect we re-join the same room.
 */
function connectToRoom(
  server: ServerLocation,
  room: RoomInfo,
  name: string,
): Promise<{ conn: Connection; room: RoomInfo }> {
  const conn = new Connection(server.wsUrl);
  conn.on('open', () => conn.sendNow({ type: 'join', room: room.id, name, codec: netFlags.codec }));
  conn.on('welcome', () => conn.markReady()); // flush chat typed while we were reconnecting

  return new Promise((resolve, reject) => {
    const wait = new AbortController();
    const { signal } = wait;
    let refusal: string | null = null;
    conn.on('error', (e) => (refusal = e.message), { signal });
    conn.on(
      'welcome',
      (e) => {
        wait.abort();
        resolve({ conn, room: e.room });
      },
      { signal },
    );
    conn.on(
      'status',
      (e) => {
        if (e.state !== 'closed' && e.state !== 'waiting') return;
        wait.abort();
        conn.close();
        reject(new Error(refusal ?? `could not connect (code ${e.code ?? '?'})`));
      },
      { signal },
    );
    conn.connect();
  });
}

// ---------- offline match (Labs 1–4). Resolves when the player presses Esc. ----------
function playOfflineMatch(room: RoomInfo, name: string, assets: GameAssets): Promise<void> {
  const arena = assets.arenas[room.arena] ?? DEFAULT_ARENA;
  const { world, player } = createGame({ ...bounds, arena, playerName: name });
  const match = new AbortController(); // ends every subscription of this match
  const { signal } = match;
  attachAudio(world.events, bounds.width, audio, { signal });
  const hud = createHud(world.events, { playerId: player.id, signal });
  const battlefield = createBattlefield(bounds.width, bounds.height, {
    terrain: arena.terrain,
    seed: arena.seed,
  });
  let lastFrame = performance.now() / 1000;
  const view = createWorldView(world); // reused draw lists (Lab 7)

  function simulate(dt: number): void {
    const controls = {
      left: input.isDown('KeyA') || input.isDown('ArrowLeft'),
      right: input.isDown('KeyD') || input.isDown('ArrowRight'),
      thrust: input.isDown('KeyW') || input.isDown('ArrowUp'),
      fire: input.isDown('Space'),
    };
    world.step(dt, new Map([[player.id, controls]]));
    input.consume();
  }

  function render(alpha: number): void {
    const time = performance.now() / 1000;
    battlefield.draw(ctx, time, Math.min(0.1, time - lastFrame));
    lastFrame = time;
    view.refresh();
    drawWorld(ctx, view, alpha, time, assets.sprites);
    hud.draw(ctx, {
      stats: loop.getStats(),
      player,
      ...bounds,
      room: `${room.name} (offline)`,
      audio,
      entities: world.size,
    });
  }

  const loop = createLoop({ step: 1 / 60, simulate, render });
  setMenuMode(false);
  loop.start();

  if (IS_DEV) {
    window.game = { world, player, audio, assets };
    if (flags.demo === 'this') demonstrateThisBug(player, world);
  }

  return new Promise<void>((resolve) => {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Escape') return;
        loop.stop();
        match.abort();
        setMenuMode(true);
        resolve();
      },
      { signal },
    );
  });
}

// ---------- the whole app as one async flow ----------
async function main(): Promise<void> {
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
  const joinRoom = q.get('join');
  let autoJoin = joinRoom ? { room: joinRoom, name: q.get('name') ?? 'Pilot' } : null;

  let error: string | null = null;
  for (;;) {
    if (autoJoin) {
      const target = autoJoin;
      autoJoin = null;
      const off = lobby.on('rooms', () => {
        off();
        try {
          lobby.join(target.room, target.name);
        } catch (err: unknown) {
          console.warn('[autojoin]', err instanceof Error ? err.message : err);
        }
      });
    }
    ctx.clearRect(0, 0, bounds.width, bounds.height);
    const { room, name } = await showLobby(el(document, '#lobby', HTMLElement), lobby, {
      notices: assets.notices,
      onGesture: () => void audio.unlock(),
      error,
    });
    error = null;
    if (!server) {
      await playOfflineMatch(room, name, assets);
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
    } catch (err: unknown) {
      error = `Could not join ${room.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

void main();
