// Tiny structured logger: one line per event, `time level msg key=value ...`.
// (Lab 8 switches to JSON logs for a log collector.)
export type LogFields = Readonly<Record<string, unknown>>;

function fmt(fields: LogFields): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`)
    .join(' ');
}

function line(level: string, msg: string, fields?: LogFields): string {
  const time = new Date().toISOString().slice(11, 23);
  return `${time} ${level.padEnd(5)} ${msg}${fields ? ' ' + fmt(fields) : ''}`;
}

export const log = {
  info: (msg: string, fields?: LogFields) => console.log(line('info', msg, fields)),
  warn: (msg: string, fields?: LogFields) => console.warn(line('warn', msg, fields)),
  error: (msg: string, fields?: LogFields) => console.error(line('error', msg, fields)),
};
