// Tiny structured logger: one line per event, `time level msg key=value ...`.
// (Lab 8 switches to JSON logs for a log collector.)
function fmt(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`)
    .join(' ');
}

function line(level, msg, fields) {
  const time = new Date().toISOString().slice(11, 23);
  return `${time} ${level.padEnd(5)} ${msg}${fields ? ' ' + fmt(fields) : ''}`;
}

export const log = {
  info: (msg, fields) => console.log(line('info', msg, fields)),
  warn: (msg, fields) => console.warn(line('warn', msg, fields)),
  error: (msg, fields) => console.error(line('error', msg, fields)),
};
