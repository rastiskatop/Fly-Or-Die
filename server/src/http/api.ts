import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { sendJson, sendError, readJsonBody, HttpError, CORS_HEADERS } from './respond.ts';
import { parseCreateRoom } from '../protocol.ts';
import { RoomLimitError } from '../rooms.ts';
import { listReplays, replayPath } from '../log/replay.ts';
import { log } from '../logger.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from '../config.ts';
import type { RoomManager } from '../rooms.ts';

export interface ApiContext {
  readonly config: ServerConfig;
  readonly rooms: RoomManager;
  readonly stats: { connections: number; dropped: number; bytesIn: number; bytesOut: number };
  readonly netStats: () => Readonly<Record<string, unknown>>;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ...params: string[]
) => void | Promise<void>;
type Route = readonly [method: 'GET' | 'POST', pattern: RegExp, handler: Handler];
export type ApiHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * JSON API + health + debug routes. Returns true if the request was handled.
 */
export function createApiHandler(ctx: ApiContext): ApiHandler {
  const { config, rooms } = ctx;

  const routes: Route[] = [
    ['GET', /^\/health$/, health],
    ['GET', /^\/api\/rooms$/, listRooms],
    ['POST', /^\/api\/rooms$/, createRoom],
    ['GET', /^\/api\/stats$/, netStats],
    ['GET', /^\/api\/replays$/, replays],
    ['GET', /^\/api\/replays\/([^/]+)$/, streamReplay],
  ];
  if (config.debugRoutes) {
    routes.push(
      ['GET', /^\/api\/debug\/block$/, debugBlock],
      ['GET', /^\/api\/debug\/crash$/, debugCrash],
      ['GET', /^\/api\/debug\/replays\/([^/]+)\/naive$/, debugNaiveReplay],
    );
  }

  return async function handleApi(req, res, url) {
    const isApi = url.pathname === '/health' || url.pathname.startsWith('/api/');
    if (!isApi) return false;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS).end(); // CORS preflight for POST with a JSON body
      return true;
    }

    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m) continue;
      if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) continue;
      try {
        await handler(req, res, url, ...m.slice(1));
      } catch (err) {
        if (err instanceof HttpError) sendError(res, err.status, err.message);
        else {
          log.error('api handler failed', { path: url.pathname, err: message(err) });
          if (!res.headersSent) sendError(res, 500, 'internal error');
          else res.destroy();
        }
      }
      return true;
    }
    sendError(res, 404, `no route ${req.method} ${url.pathname}`);
    return true;
  };

  // ---------- handlers ----------

  function health(_req: IncomingMessage, res: ServerResponse): void {
    const mem = process.memoryUsage();
    sendJson(res, 200, {
      status: 'ok',
      service: 'flyordie',
      version: 1,
      uptimeS: Math.round(process.uptime()),
      rooms: rooms.size,
      players: rooms.playerCount,
      connections: ctx.stats.connections,
      rssMB: +(mem.rss / 2 ** 20).toFixed(1),
      heapUsedMB: +(mem.heapUsed / 2 ** 20).toFixed(1),
    });
  }

  /** Lab 5: tick duration/jitter per match + bytes/s per connection. */
  function netStats(_req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, { ...ctx.netStats(), totals: ctx.stats });
  }

  function listRooms(_req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, { rooms: rooms.list(), serverTime: Date.now() });
  }

  async function createRoom(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const parsed = parseCreateRoom(body);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    try {
      const room = rooms.create(parsed.value);
      log.info('room created', { room: room.id, name: room.name, arena: room.arena });
      sendJson(res, 201, { room: room.toJSON() }, { Location: `/api/rooms/${room.id}` });
    } catch (err) {
      if (err instanceof RoomLimitError) throw new HttpError(503, err.message);
      throw err;
    }
  }

  async function replays(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJson(res, 200, { replays: await listReplays(config.logDir) });
  }

  /** Streams the NDJSON file. Memory stays flat: pipeline respects the client's pace. */
  async function streamReplay(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    id = '',
  ): Promise<void> {
    const file = replayPath(config.logDir, id);
    if (!file) throw new HttpError(400, 'bad replay id');
    const info = await stat(file).catch(() => null);
    if (!info) throw new HttpError(404, 'replay not found');
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Length': info.size,
      ...CORS_HEADERS,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(createReadStream(file), res).catch((err: unknown) => {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code !== 'ERR_STREAM_PREMATURE_CLOSE')
        log.warn('replay stream failed', { id, err: message(err) });
    });
  }

  // ---------- debug routes (DEBUG_ROUTES=true, never in production) ----------

  /** Burns the CPU synchronously: while this runs, NOTHING else in the process runs. */
  function debugBlock(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const ms = Math.min(5000, Number(url.searchParams.get('ms')) || 300);
    const started = performance.now();
    while (performance.now() - started < ms) {
      // busy-wait: the event loop is stuck in this frame
    }
    sendJson(res, 200, { blockedMs: ms });
  }

  /**
   * ?kind=emitter   → 'error' emitted on an EventEmitter with no 'error' listener → it THROWS
   * ?kind=rejection → a rejected promise nobody handles → Node ≥ 15 treats it as fatal
   * add &fixed=1    → the same failure, handled: a listener / a .catch(), the server lives on
   */
  function debugCrash(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const kind = url.searchParams.get('kind') ?? 'emitter';
    const fixed = url.searchParams.get('fixed') === '1';
    sendJson(res, 202, { kind, fixed, note: fixed ? 'handled' : 'server will crash' });

    setImmediate(() => {
      if (kind === 'emitter') {
        const emitter = new EventEmitter();
        if (fixed)
          emitter.on('error', (err: unknown) =>
            log.warn('handled emitter error', { err: message(err) }),
          );
        emitter.emit('error', new Error('demo: disk full while writing the match log'));
      } else {
        const p = Promise.reject(new Error('demo: database timed out'));
        if (fixed) p.catch((err: unknown) => log.warn('handled rejection', { err: message(err) }));
      }
    });
  }

  /** Anti-example for the backpressure graph: ignores write()'s return value. */
  async function debugNaiveReplay(
    _req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    id = '',
  ): Promise<void> {
    const file = replayPath(config.logDir, id);
    if (!file) throw new HttpError(400, 'bad replay id');
    const info = await stat(file).catch(() => null);
    if (!info) throw new HttpError(404, 'replay not found');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Length': info.size });
    const rs = createReadStream(file);
    rs.on('data', (chunk) => res.write(chunk)); // ← returns false when the client is slow; ignored
    rs.on('end', () => res.end());
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
  }
}
