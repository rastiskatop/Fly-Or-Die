// Live server dashboard (Lab 8): reads /metrics (Prometheus text) every 2 s and shows the numbers
// that matter at 3 a.m. Counters (messages, bytes, rejections) become per-second rates between two
// scrapes; gauges are shown as they are. Each tile keeps a 2-minute sparkline. No libraries.
import { el } from './lobby/lobby-view.ts';
import { parseMetrics, sum, byLabel, type Sample } from './metrics-text.ts';

const PERIOD_MS = 2000;
const HISTORY = 60; // 2 minutes of points

interface Tile {
  readonly title: string;
  readonly unit: string;
  readonly digits: number;
  readonly warn?: number; // highlight above this
  readonly value: (now: Sample, prev: Sample | null, dt: number) => number;
}

const rate = (name: string) => (now: Sample, prev: Sample | null, dt: number) =>
  prev ? Math.max(0, (sum(now, name) - sum(prev, name)) / dt) : 0;

const TILES: readonly Tile[] = [
  { title: 'players', unit: '', digits: 0, value: (s) => sum(s, 'flyordie_players') },
  { title: 'rooms', unit: '', digits: 0, value: (s) => sum(s, 'flyordie_rooms') },
  { title: 'connections', unit: '', digits: 0, value: (s) => sum(s, 'flyordie_ws_connections') },
  { title: 'messages in', unit: '/s', digits: 0, value: rate('flyordie_ws_messages_in_total') },
  { title: 'messages out', unit: '/s', digits: 0, value: rate('flyordie_ws_messages_out_total') },
  {
    title: 'bytes out',
    unit: ' KB/s',
    digits: 1,
    value: (n, p, dt) => rate('flyordie_ws_bytes_out_total')(n, p, dt) / 1024,
  },
  {
    title: 'worst tick p99',
    unit: ' ms',
    digits: 2,
    warn: 33.3,
    value: (s) => Math.max(0, ...byLabel(s, 'flyordie_tick_p99_ms', 'room').values()),
  },
  {
    title: 'event loop busy',
    unit: ' %',
    digits: 1,
    warn: 90,
    value: (s) => 100 * sum(s, 'flyordie_event_loop_utilization'),
  },
  {
    title: 'RSS',
    unit: ' MB',
    digits: 0,
    value: (s) => sum(s, 'flyordie_process_resident_memory_bytes') / 2 ** 20,
  },
  {
    title: 'rejections',
    unit: '/s',
    digits: 1,
    warn: 5,
    value: rate('flyordie_ws_rejections_total'),
  },
];

const grid = el(document, '#tiles', HTMLElement);
const status = el(document, '#status', HTMLElement);
const detail = el(document, '#detail', HTMLElement);
const tiles = TILES.map((t) => {
  const box = document.createElement('section');
  box.className = 'tile';
  box.innerHTML = '<h2></h2><div class="v"></div><canvas width="220" height="40"></canvas>';
  el(box, 'h2', HTMLHeadingElement).textContent = t.title;
  grid.append(box);
  return {
    t,
    value: el(box, '.v', HTMLDivElement),
    canvas: el(box, 'canvas', HTMLCanvasElement),
    box,
    history: [] as number[],
  };
});

function spark(canvas: HTMLCanvasElement, points: readonly number[]): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  const max = Math.max(1e-9, ...points);
  g.strokeStyle = '#d9b44a';
  g.lineWidth = 2;
  g.beginPath();
  points.forEach((v, i) => {
    const x = (i / (HISTORY - 1)) * w;
    const y = h - 3 - (v / max) * (h - 6);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
}

let prev: Sample | null = null;
let prevAt = 0;
async function tick(): Promise<void> {
  try {
    const res = await fetch('./metrics', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const now = parseMetrics(await res.text());
    const at = performance.now();
    const dt = prev ? (at - prevAt) / 1000 : 1;
    for (const tile of tiles) {
      const v = tile.t.value(now, prev, dt);
      tile.value.textContent = `${v.toFixed(tile.t.digits)}${tile.t.unit}`;
      tile.box.classList.toggle('warn', tile.t.warn !== undefined && v > tile.t.warn);
      tile.history.push(v);
      if (tile.history.length > HISTORY) tile.history.shift();
      spark(tile.canvas, tile.history);
    }
    const rooms =
      [...byLabel(now, 'flyordie_tick_p99_ms', 'room')]
        .map(([r, ms]) => `${r} ${ms.toFixed(2)} ms`)
        .join(' · ') || 'no running matches';
    const rejected =
      [...byLabel(now, 'flyordie_ws_rejections_total', 'reason')]
        .map(([r, n]) => `${r} ${n}`)
        .join(' · ') || 'none';
    const version = [...byLabel(now, 'flyordie_build_info', 'version').keys()][0] ?? '?';
    detail.textContent = `tick p99 by room: ${rooms}\nrejections since start: ${rejected}\nserver version: ${version}`;
    status.textContent = `live · updated ${new Date().toLocaleTimeString()}`;
    status.className = 'ok';
    prev = now;
    prevAt = at;
  } catch (err: unknown) {
    status.textContent = `server unreachable: ${err instanceof Error ? err.message : 'error'} — retrying`;
    status.className = 'down';
  }
}

void tick();
setInterval(() => void tick(), PERIOD_MS);
