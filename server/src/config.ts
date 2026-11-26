// All configuration comes from the environment (process.env), never from code — parsed ONCE through
// a zod schema: strings → numbers/booleans, ranges checked, defaults applied, and the result is a
// fully typed, frozen ServerConfig. A bad value fails at startup with a readable message.
import { resolve } from 'node:path';
import { z } from 'zod';

const here = import.meta.dirname; // ESM replacement for CommonJS __dirname

const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);
const bool = (def: boolean) =>
  z
    .enum(['1', 'true', 'yes', '0', 'false', 'no'])
    .transform((v) => ['1', 'true', 'yes'].includes(v))
    .optional()
    .transform((v) => v ?? def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(8787, 0, 65535),
  // unset: 0.0.0.0 in production (reachable from outside the container), 127.0.0.1 on a laptop
  HOST: z.string().min(1).optional(),
  STATIC_DIR: z.string().default('../client/dist'),
  LOG_DIR: z.string().default('logs'),
  ARENA_DIR: z.string().default('../client/public/assets/arenas'),
  MAX_ROOMS: int(20, 1, 1000),
  MAX_PLAYERS_PER_ROOM: int(8, 1, 64),
  MAX_PAYLOAD_BYTES: int(4096, 256, 1 << 20),
  MAX_BODY_BYTES: int(1024, 64, 1 << 20),
  RATE_LIMIT_PER_SEC: int(10, 1, 1000),
  RATE_LIMIT_BURST: int(20, 1, 1000),
  JOIN_TIMEOUT_MS: int(5000, 100, 600_000),
  HEARTBEAT_MS: int(15000, 50, 600_000),
  SLOW_CLIENT_BYTES: int(256 * 1024, 1024, 1 << 30),
  SHUTDOWN_TIMEOUT_MS: int(5000, 100, 600_000),
  DEBUG_ROUTES: bool(false).optional(),
  // ---- Lab 8: production ----
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  // Browser origins allowed to open a WebSocket (comma-separated). Empty: same origin only
  // (+ any localhost origin outside production, for Vite/Live Server).
  ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url().transform((u) => new URL(u).origin))),
  MAX_CONNECTIONS_PER_IP: int(16, 1, 100_000),
  // Behind a platform proxy (Render, Fly…) the socket's address is the PROXY: take the client IP
  // from the last X-Forwarded-For entry (the one the trusted proxy appended).
  TRUST_PROXY: bool(false).optional(),
  // The build's git commit: GIT_SHA (Docker build arg) or Render's RENDER_GIT_COMMIT.
  GIT_SHA: z.string().optional(),
  RENDER_GIT_COMMIT: z.string().optional(),
});

/** Empty strings in .env mean "not set". */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(cleanEnv(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  return Object.freeze({
    production,
    port: e.PORT,
    host: e.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    staticDir: resolve(here, '..', e.STATIC_DIR),
    logDir: resolve(here, '..', e.LOG_DIR),
    arenaDir: resolve(here, '..', e.ARENA_DIR),
    maxRooms: e.MAX_ROOMS,
    maxPlayersPerRoom: e.MAX_PLAYERS_PER_ROOM,
    maxPayloadBytes: e.MAX_PAYLOAD_BYTES,
    maxBodyBytes: e.MAX_BODY_BYTES,
    rateLimitPerSec: e.RATE_LIMIT_PER_SEC,
    rateLimitBurst: e.RATE_LIMIT_BURST,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    heartbeatMs: e.HEARTBEAT_MS,
    slowClientBytes: e.SLOW_CLIENT_BYTES,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    // /api/debug/* (blocking demo, crash demo, naive replay) — never in production by default
    debugRoutes: e.DEBUG_ROUTES ?? !production,
    logLevel: e.LOG_LEVEL,
    allowedOrigins: e.ALLOWED_ORIGINS,
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    trustProxy: e.TRUST_PROXY ?? false,
    version: (e.GIT_SHA ?? e.RENDER_GIT_COMMIT ?? 'dev').slice(0, 7),
  });
}

/** Inferred from the function above — the config's type is never written by hand. */
export type ServerConfig = ReturnType<typeof loadConfig>;
