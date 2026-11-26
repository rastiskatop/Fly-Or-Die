// Netgraph overlay (Lab 5): the instrument for everything netcode. Drawn on the game canvas.
import type { NetGame } from './netgame.ts';

export interface NetSimSettings {
  readonly lagMs: number;
  readonly jitterMs: number;
  readonly dropPct: number;
}
const W = 300;
const GRAPH_H = 34;

function spark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  values: readonly number[],
  max: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const px = x + (i / 119) * W;
    const py = y + GRAPH_H - Math.min(1, v / max) * GRAPH_H;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

export function drawNetgraph(
  ctx: CanvasRenderingContext2D,
  net: NetGame,
  { netsim, x = 16, y = 100, fps }: { netsim: NetSimSettings; x?: number; y?: number; fps: number },
): void {
  const h = net.history;
  const s = net.stats;
  const lines = [
    `NETGRAPH [N] hide  ·  codec ${net.codecName}  ·  tick ${s.serverTick}  ·  ${fps} fps`,
    `rtt ${s.rttMs.toFixed(0)} ms  ·  snapshot age ${(h.age.at(-1) ?? 0).toFixed(0)} ms  ·  missed ${s.snapshotsMissed}`,
    `down ${s.bytesInPerS.toFixed(1)} KB/s  ·  up ${s.bytesOutPerS.toFixed(1)} KB/s`,
    `pending inputs ${net.pending.length}  ·  correction ${s.lastCorrection.toFixed(2)} px`,
    `prediction [P] ${net.prediction ? 'ON' : 'off'}  ·  interp [I] ${net.interpolation ? 'ON' : 'off'} ${net.interpDelayMs} ms [ / ]`,
    `netsim [1-4]: ${netsim.lagMs} ms ±${netsim.jitterMs}, drop ${netsim.dropPct}%${net.chaos ? '  ·  CHAOS [C]' : ''}`,
  ];
  const height = lines.length * 15 + 3 * (GRAPH_H + 16) + 14;

  ctx.save();
  ctx.fillStyle = 'rgba(15, 18, 10, 0.72)';
  ctx.fillRect(x - 8, y - 14, W + 16, height);
  ctx.strokeStyle = 'rgba(201, 185, 141, 0.4)';
  ctx.strokeRect(x - 8, y - 14, W + 16, height);
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8dcb5';
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * 15));

  let gy = y + lines.length * 15 + 2;
  const graphs: readonly (readonly [
    label: string,
    values: readonly number[],
    max: number,
    color: string,
    unit: string,
  ])[] = [
    ['RTT', h.rtt, Math.max(100, ...h.rtt), '#7fc8ff', 'ms'],
    ['snapshot age', h.age, Math.max(100, ...h.age), '#ffd23f', 'ms'],
    [
      'correction',
      h.correction.slice(-120),
      Math.max(5, ...h.correction.slice(-120)),
      '#ff6b5a',
      'px',
    ],
  ];
  for (const [label, values, max, color, unit] of graphs) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, gy, W, GRAPH_H);
    spark(ctx, x, gy, values.slice(-120), max, color);
    ctx.fillStyle = color;
    ctx.fillText(`${label} (max ${max.toFixed(0)} ${unit})`, x + 4, gy + 11);
    gy += GRAPH_H + 16;
  }
  ctx.restore();
}
