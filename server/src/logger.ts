// Structured logging (Lab 8): one JSON object per line on stdout, via pino.
//
//   {"level":"info","time":"2026-11-27T10:15:02.113Z","service":"flyordie","version":"a1b2c3d",
//    "msg":"player joined","roomId":"eu-1","playerId":"3f9c2a1b"}
//
// Logs are an event STREAM (twelve-factor): the platform collects stdout — no files, no rotation.
// pino writes plain JSON with no formatting on the hot path; pretty-printing, if ever wanted, is a
// separate process (`node src/index.ts | npx pino-pretty`) — formatting off the main thread.
// Events carry ids (roomId, playerId, connId) so one match or one player can be filtered out.
import pino from 'pino';

export type LogFields = Readonly<Record<string, unknown>>;
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const base = pino({
  level: 'info',
  base: { service: 'flyordie' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  // Never log secrets, even by accident (a config dump, a header object…).
  redact: {
    paths: ['*.token', '*.password', '*.secret', '*.dsn', '*.authorization', '*.cookie'],
    censor: '[redacted]',
  },
});

let logger = base;

/** Applied once the config is loaded (LOG_LEVEL) and the version is known. */
export function configureLogger({ level, version }: { level: LogLevel; version: string }): void {
  logger = base.child({ version });
  logger.level = level;
}

export const log = {
  debug: (msg: string, fields?: LogFields) => logger.debug(fields ?? {}, msg),
  info: (msg: string, fields?: LogFields) => logger.info(fields ?? {}, msg),
  warn: (msg: string, fields?: LogFields) => logger.warn(fields ?? {}, msg),
  error: (msg: string, fields?: LogFields) => logger.error(fields ?? {}, msg),
  /** An Error with its stack (crash-on-unknown). */
  fatal: (msg: string, err: unknown, fields?: LogFields) =>
    logger.fatal({ ...fields, err: err instanceof Error ? err : new Error(String(err)) }, msg),
};
