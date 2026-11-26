// The subset of the Prometheus text exposition format the dashboard needs (Lab 8): one
// `name{labels} value` per line, `#` comments skipped. The constant service="flyordie" label is
// dropped to keep keys short: "flyordie_tick_p99_ms{room="eu-1"}" → 4.62.
export type Sample = Map<string, number>;

export function parseMetrics(text: string): Sample {
  const out: Sample = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+([-+eE\d.]+|NaN)/.exec(line);
    if (!m?.[1] || m[3] === undefined) continue;
    const labels = (m[2] ?? '')
      .replace(/,?service="flyordie"/, '')
      .replace('{,', '{')
      .replace('{}', '');
    out.set(m[1] + labels, Number(m[3]));
  }
  return out;
}

/** Sum of every series of a metric (all label combinations). */
export function sum(s: Sample, name: string): number {
  let t = 0;
  for (const [k, v] of s) if (k === name || k.startsWith(name + '{')) t += v;
  return t;
}

/** One label's value → the series value, e.g. byLabel(s, 'flyordie_tick_p99_ms', 'room'). */
export function byLabel(s: Sample, name: string, label: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = new RegExp(`^${name}\\{.*${label}="([^"]+)"`);
  for (const [k, v] of s) {
    const m = re.exec(k);
    if (m?.[1]) out.set(m[1], v);
  }
  return out;
}
