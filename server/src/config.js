// All configuration comes from the environment (process.env), never from code.
// Values are parsed, validated and defaulted HERE, once; the rest of the server imports `config`.
// In dev, `node --env-file-if-exists=.env` loads server/.env (see .env.example).
import { resolve } from 'node:path';

const here = import.meta.dirname; // ESM replacement for CommonJS __dirname

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`config: ${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  throw new Error(`config: ${name} must be true/false, got "${raw}"`);
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig() {
  const production = str('NODE_ENV', 'development') === 'production';
  return Object.freeze({
    production,
    port: int('PORT', 8787, { min: 0, max: 65535 }),
    host: str('HOST', '127.0.0.1'),
    staticDir: resolve(here, '..', str('STATIC_DIR', '../client/dist')),
    logDir: resolve(here, '..', str('LOG_DIR', 'logs')),

    maxRooms: int('MAX_ROOMS', 20, { min: 1, max: 1000 }),
    maxPlayersPerRoom: int('MAX_PLAYERS_PER_ROOM', 8, { min: 1, max: 64 }),
    maxPayloadBytes: int('MAX_PAYLOAD_BYTES', 4096, { min: 256, max: 1 << 20 }),
    maxBodyBytes: int('MAX_BODY_BYTES', 1024, { min: 64, max: 1 << 20 }),

    rateLimitPerSec: int('RATE_LIMIT_PER_SEC', 10, { min: 1, max: 1000 }),
    rateLimitBurst: int('RATE_LIMIT_BURST', 20, { min: 1, max: 1000 }),
    joinTimeoutMs: int('JOIN_TIMEOUT_MS', 5000, { min: 100 }),
    heartbeatMs: int('HEARTBEAT_MS', 15000, { min: 50 }),
    slowClientBytes: int('SLOW_CLIENT_BYTES', 256 * 1024, { min: 1024 }),

    // /api/debug/* (blocking demo, crash demo, naive replay) — never in production
    debugRoutes: bool('DEBUG_ROUTES', !production),
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 5000, { min: 100 }),
  });
}
