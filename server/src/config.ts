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
  HOST: z.string().min(1).default('127.0.0.1'),
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
    host: e.HOST,
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
  });
}

/** Inferred from the function above — the config's type is never written by hand. */
export type ServerConfig = ReturnType<typeof loadConfig>;
