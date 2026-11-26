import http from 'node:http';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.ts';
import { RoomManager, seedDefaultRooms } from './rooms.ts';
import { startMatchLog } from './log/matchlog.ts';
import { createStaticHandler } from './http/static.ts';
import { createApiHandler } from './http/api.ts';
import { sendError } from './http/respond.ts';
import { attachWebSockets } from './ws.ts';
import { log } from './logger.ts';
import { Match } from './match.ts';
import { DEFAULT_ARENA } from '@flyordie/shared/sim/game.ts';
import { ArenaSchema, type ArenaRules } from '@flyordie/shared/sim/arena.ts';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const config = loadConfig();
await mkdir(config.logDir, { recursive: true }); // top-level await: ESM only

const stats = { connections: 0, dropped: 0, bytesIn: 0, bytesOut: 0 };

// Arena definitions shared with the client (client/public/assets/arenas/*.json)
// validated with the SAME zod schema the client uses — a typo in a JSON file is caught here, not mid-match
const arenas = new Map<string, ArenaRules>();
const arenaFiles = (await readdir(config.arenaDir).catch((): string[] => [])).filter((f) =>
  f.endsWith('.json'),
);
for (const file of arenaFiles) {
  try {
    const parsed = ArenaSchema.safeParse(
      JSON.parse(await readFile(join(config.arenaDir, file), 'utf8')),
    );
    if (!parsed.success) {
      log.warn('invalid arena file, using defaults', {
        file,
        err: parsed.error.issues[0]?.message ?? 'invalid',
      });
      continue;
    }
    arenas.set(parsed.data.id, parsed.data);
  } catch (err: unknown) {
    log.warn('bad arena file, using defaults', { file, err: errorMessage(err) });
  }
}
const rooms = new RoomManager({
  maxRooms: config.maxRooms,
  maxPlayersPerRoom: config.maxPlayersPerRoom,
});

// ---------- authoritative matches (Lab 5): one 30 Hz simulation per room with players ----------
const matches = new Map<string, Match>(); // roomId -> Match
rooms.on('roomCreated', (room) => {
  room.on('matchStart', () => {
    const match = new Match({ roomId: room.id, arena: arenas.get(room.arena) ?? DEFAULT_ARENA });
    matches.set(room.id, match);
    sockets.wireMatch(match);
    match.on('snapshot', ({ events }) => {
      for (const e of events) {
        if (e.type === 'exploded' && e.kind === 'ship') room.record('kill', { ship: e.shipId });
        if (e.type === 'pickup') room.record('pickup', { ship: e.shipId, effect: e.effect });
      }
    });
    match.start();
    log.info('match started', { room: room.id, arena: room.arena });
  });
  // Registered before ws.js wires the room, so the ship exists when the roster is broadcast.
  room.on('join', (player) => {
    player.shipId = matches.get(room.id)?.addPlayer(player.id, player.name);
  });
  room.on('leave', (player) => matches.get(room.id)?.removePlayer(player.id));
  room.on('matchEnd', () => {
    const match = matches.get(room.id);
    if (!match) return;
    match.stop();
    matches.delete(room.id);
    log.info('match stopped', { room: room.id, ticks: match.stats.ticks });
  });
});

// ---------- match logs: one NDJSON file per match, streamed ----------
const openLogs = new Set<Promise<void>>();
rooms.on('roomCreated', (room) => {
  room.on('matchStart', () => {
    const matchLog = startMatchLog(room, config.logDir);
    openLogs.add(matchLog.done);
    log.info('match log started', { room: room.id, file: matchLog.id });
    matchLog.done
      .then(() => log.info('match log closed', { room: room.id, file: matchLog.id }))
      .catch((err) => log.error('match log failed', { room: room.id, err: err.message }))
      .finally(() => openLogs.delete(matchLog.done));
  });
});

// ---------- HTTP ----------
const serveStatic = createStaticHandler(config.staticDir);
const handleApi = createApiHandler({
  config,
  rooms,
  stats,
  netStats: () => ({
    matches: [...matches.values()].map((m) => m.statsJSON()),
    connections: sockets.connectionStats(),
  }),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost'); // req.url is only the path + query
  try {
    if (await handleApi(req, res, url)) return;
    if (await serveStatic(req, res, url.pathname)) return;
    sendError(res, 404, 'not found');
  } catch (err: unknown) {
    log.error('request failed', { path: url.pathname, err: errorMessage(err) });
    if (!res.headersSent) sendError(res, 500, 'internal error');
  }
});
server.on('clientError', (err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

// ---------- WebSocket on /ws (same port: HTTP Upgrade) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
const sockets = attachWebSockets(wss, { rooms, matches, config, stats });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

seedDefaultRooms(rooms); // after the listeners above, so the default rooms are wired too

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log.info('server listening', {
    url: `http://${config.host}:${port}`,
    static: config.staticDir,
    logs: config.logDir,
    debugRoutes: config.debugRoutes,
  });
  const open = `http://localhost:${port}`;
  log.info(`▶ open the game: ${open}  (stop with Ctrl+C)`);
  process.send?.({ type: 'listening', port }); // lets tests/scripts that fork us find the port
});

// ---------- graceful shutdown ----------
let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  const force = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  force.unref();

  server.close(); // 1. stop accepting new connections
  // 2. close every WebSocket with 1001 "going away" (clients will reconnect elsewhere / later)
  await Promise.race([sockets.closeAll(), new Promise((r) => setTimeout(r, 1000))]);
  server.closeIdleConnections();
  rooms.endAllMatches('shutdown'); // 3. final line in every match log…
  await Promise.allSettled([...openLogs]); //    …and wait until they're flushed to disk
  log.info('bye', { exitCode });
  process.exit(exitCode);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// On Windows a parent can't deliver SIGTERM (child.kill() terminates the process outright), so
// tests and scripts that fork the server ask for a graceful shutdown over IPC instead.
process.on('message', (m: unknown) => {
  if (typeof m === 'object' && m !== null && 'type' in m && m.type === 'shutdown')
    void shutdown('ipc');
});

// Last resort. These are BUGS — the process state is unknown, so we don't continue as if nothing
// happened: log it, flush the match logs, exit 1, and let the supervisor (Docker, Lab 8) restart us.
process.on('uncaughtException', (err) => {
  log.error('FATAL uncaughtException', { err: err.message });
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason: unknown) => {
  log.error('FATAL unhandledRejection', { err: errorMessage(reason) });
  void shutdown('unhandledRejection', 1);
});
