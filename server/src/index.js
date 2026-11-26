import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { RoomManager, seedDefaultRooms } from './rooms.js';
import { startMatchLog } from './log/matchlog.js';
import { createStaticHandler } from './http/static.js';
import { createApiHandler } from './http/api.js';
import { sendError } from './http/respond.js';
import { attachWebSockets } from './ws.js';
import { log } from './logger.js';

const config = loadConfig();
await mkdir(config.logDir, { recursive: true }); // top-level await: ESM only

const stats = { connections: 0, dropped: 0 };
const rooms = new RoomManager({
  maxRooms: config.maxRooms,
  maxPlayersPerRoom: config.maxPlayersPerRoom,
});

// ---------- match logs: one NDJSON file per match, streamed ----------
const openLogs = new Set();
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
const handleApi = createApiHandler({ config, rooms, stats });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); // req.url is only the path + query
  try {
    if (await handleApi(req, res, url)) return;
    if (await serveStatic(req, res, url.pathname)) return;
    sendError(res, 404, 'not found');
  } catch (err) {
    log.error('request failed', { path: url.pathname, err: err.message });
    if (!res.headersSent) sendError(res, 500, 'internal error');
  }
});
server.on('clientError', (err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

// ---------- WebSocket on /ws (same port: HTTP Upgrade) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
const sockets = attachWebSockets(wss, { rooms, config, stats });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

seedDefaultRooms(rooms); // after the listeners above, so the default rooms are wired too

server.listen(config.port, config.host, () => {
  const { port } = server.address();
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
async function shutdown(signal, exitCode = 0) {
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
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// On Windows a parent can't deliver SIGTERM (child.kill() terminates the process outright), so
// tests and scripts that fork the server ask for a graceful shutdown over IPC instead.
process.on('message', (m) => {
  if (m?.type === 'shutdown') shutdown('ipc');
});

// Last resort. These are BUGS — the process state is unknown, so we don't continue as if nothing
// happened: log it, flush the match logs, exit 1, and let the supervisor (Docker, Lab 8) restart us.
process.on('uncaughtException', (err) => {
  log.error('FATAL uncaughtException', { err: err.message });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  log.error('FATAL unhandledRejection', { err: reason?.message ?? String(reason) });
  shutdown('unhandledRejection', 1);
});
