import { PLANE_TOP } from './art.ts';

// Top-down battlefield under the arena: fields, dirt roads with tyre tracks, an airstrip, trenches,
// craters, sandbag emplacements, trees and a faint tactical-map grid. Generated ONCE per arena into
// an offscreen canvas (seeded → same arena, same map), then blitted every frame. On top of it, a cheap
// animated layer: drifting cloud shadows and the shadows of planes flying overhead.

interface Palette {
  readonly base: string;
  readonly patches: readonly string[];
  readonly road: string;
  readonly track: string;
  readonly crater: string;
  readonly rim: string;
  readonly tree: string;
  readonly sandbag: string;
  readonly trench: string;
  readonly strip: string;
  readonly grid: string;
  readonly label: string;
}

export type Terrain = 'grass' | 'desert' | 'snow';

const PALETTES: Record<Terrain, Palette> = {
  grass: {
    base: '#5b6a3a',
    patches: ['#4d5c2f', '#6a7a44', '#55643a', '#75844b', '#47552b'],
    road: '#8b7a56',
    track: 'rgba(60, 48, 30, 0.45)',
    crater: '#3b3627',
    rim: 'rgba(150, 130, 95, 0.55)',
    tree: '#2c3a1d',
    sandbag: '#b9a679',
    trench: '#3a3222',
    strip: '#6f6f68',
    grid: 'rgba(20, 28, 10, 0.22)',
    label: 'rgba(20, 28, 10, 0.45)',
  },
  desert: {
    base: '#c7b088',
    patches: ['#bba37a', '#d3c096', '#b39a6c', '#cdb98e', '#a98f62'],
    road: '#a48c62',
    track: 'rgba(90, 70, 40, 0.4)',
    crater: '#7d6748',
    rim: 'rgba(230, 210, 170, 0.5)',
    tree: '#6e6b3c',
    sandbag: '#e0cfa3',
    trench: '#8a734f',
    strip: '#8d8a80',
    grid: 'rgba(90, 70, 40, 0.22)',
    label: 'rgba(90, 70, 40, 0.5)',
  },
  snow: {
    base: '#dde3e6',
    patches: ['#cdd6db', '#e8edef', '#c1ccd2', '#d6dee2', '#b8c4ca'],
    road: '#a7b0b5',
    track: 'rgba(80, 90, 98, 0.4)',
    crater: '#6d777c',
    rim: 'rgba(255, 255, 255, 0.6)',
    tree: '#2d4637',
    sandbag: '#9aa39f',
    trench: '#7f8a90',
    strip: '#8b9297',
    grid: 'rgba(60, 75, 85, 0.2)',
    label: 'rgba(60, 75, 85, 0.45)',
  },
};

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Battlefield {
  draw(ctx: CanvasRenderingContext2D, time: number, dt: number): void;
}

export function createBattlefield(
  width: number,
  height: number,
  { terrain = 'grass', seed = 1 }: { terrain?: Terrain; seed?: number } = {},
): Battlefield {
  const pal = PALETTES[terrain];
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas not supported');
  g.scale(scale, scale);
  const r = mulberry32(seed * 7919 + terrain.length);
  const rnd = (a: number, b: number): number => a + r() * (b - a);

  // 1. Base + soft camo-like patches of vegetation / soil
  g.fillStyle = pal.base;
  g.fillRect(0, 0, width, height);
  g.filter = 'blur(14px)';
  for (let i = 0; i < 70; i++) {
    g.fillStyle = pal.patches[Math.floor(r() * pal.patches.length)] ?? pal.base;
    g.globalAlpha = rnd(0.35, 0.8);
    g.beginPath();
    g.ellipse(
      rnd(-50, width + 50),
      rnd(-50, height + 50),
      rnd(40, 160),
      rnd(25, 90),
      rnd(0, Math.PI),
      0,
      Math.PI * 2,
    );
    g.fill();
  }
  g.filter = 'none';
  g.globalAlpha = 1;

  // 2. Fine grain
  for (let i = 0; i < 6000; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
    g.fillRect(rnd(0, width), rnd(0, height), 1.5, 1.5);
  }

  // 3. Dirt roads with tyre tracks
  for (let k = 0; k < 2; k++) {
    // A tuple of 4 [x, y] tuples: spreading them into moveTo/bezierCurveTo is now type-checked.
    const pts: readonly [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
    ] = [
      [rnd(-40, width * 0.2), rnd(0, height)],
      [rnd(width * 0.25, width * 0.5), rnd(0, height)],
      [rnd(width * 0.5, width * 0.75), rnd(0, height)],
      [rnd(width * 0.8, width + 40), rnd(0, height)],
    ];
    const path = () => {
      g.beginPath();
      g.moveTo(...pts[0]);
      g.bezierCurveTo(...pts[1], ...pts[2], ...pts[3]);
    };
    g.lineCap = 'round';
    g.strokeStyle = pal.road;
    g.lineWidth = 26;
    g.globalAlpha = 0.85;
    path();
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = pal.track;
    g.lineWidth = 2.5;
    g.setLineDash([10, 4]);
    for (const off of [-6, 6]) {
      g.save();
      g.translate(0, off);
      path();
      g.stroke();
      g.restore();
    }
    g.setLineDash([]);
  }

  // 4. Airstrip with markings
  {
    const cx = rnd(width * 0.3, width * 0.7);
    const cy = rnd(height * 0.3, height * 0.7);
    const len = 520;
    g.save();
    g.translate(cx, cy);
    g.rotate(rnd(-0.6, 0.6));
    g.fillStyle = pal.strip;
    g.globalAlpha = 0.75;
    g.fillRect(-len / 2, -22, len, 44);
    g.globalAlpha = 0.8;
    g.fillStyle = 'rgba(240, 240, 230, 0.75)';
    for (let x = -len / 2 + 40; x < len / 2 - 40; x += 46) g.fillRect(x, -1.5, 24, 3);
    for (const end of [-1, 1])
      for (let y = -16; y <= 12; y += 7) g.fillRect(end * (len / 2 - 22) - 8, y, 16, 3);
    g.restore();
    g.globalAlpha = 1;
  }

  // 5. Zig-zag trench lines
  for (let k = 0; k < 2; k++) {
    let x = rnd(0, width);
    let y = rnd(0, height);
    const ang = rnd(0, Math.PI * 2);
    g.strokeStyle = pal.trench;
    g.lineWidth = 7;
    g.lineJoin = 'miter';
    g.beginPath();
    g.moveTo(x, y);
    for (let i = 0; i < 12; i++) {
      const zig = i % 2 ? 0.7 : -0.7;
      x += Math.cos(ang + zig) * 28;
      y += Math.sin(ang + zig) * 28;
      g.lineTo(x, y);
    }
    g.stroke();
    g.strokeStyle = pal.rim;
    g.lineWidth = 1.5;
    g.stroke();
  }

  // 6. Shell craters
  for (let i = 0; i < 26; i++) {
    const x = rnd(0, width);
    const y = rnd(0, height);
    const cr = rnd(6, 24);
    const grad = g.createRadialGradient(x, y, 0, x, y, cr);
    grad.addColorStop(0, pal.crater);
    grad.addColorStop(0.7, pal.crater);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, cr, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = pal.rim;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x - 1, y - 1, cr * 0.85, 0, Math.PI * 2);
    g.stroke();
  }

  // 7. Sandbag emplacements (rings of bags)
  for (let i = 0; i < 5; i++) {
    const x = rnd(60, width - 60);
    const y = rnd(60, height - 60);
    const rr = rnd(16, 26);
    const n = Math.round(rr * 0.9);
    for (let k = 0; k < n; k++) {
      if (k > n * 0.8) continue; // an opening
      const a = (k / n) * Math.PI * 2;
      g.save();
      g.translate(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      g.rotate(a + Math.PI / 2);
      g.fillStyle = pal.sandbag;
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 1;
      g.beginPath();
      g.roundRect(-5, -3, 10, 6, 2.5);
      g.fill();
      g.stroke();
      g.restore();
    }
  }

  // 8. Trees / scrub clusters with shadows
  for (let i = 0; i < 16; i++) {
    const cx = rnd(0, width);
    const cy = rnd(0, height);
    const count = Math.floor(rnd(3, 9));
    for (let k = 0; k < count; k++) {
      const x = cx + rnd(-26, 26);
      const y = cy + rnd(-20, 20);
      const tr = rnd(5, 11);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath();
      g.arc(x + 4, y + 4, tr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = pal.tree;
      g.beginPath();
      g.arc(x, y, tr, 0, Math.PI * 2);
      g.fill();
    }
  }

  // 9. Faint tactical-map grid with coordinates
  g.strokeStyle = pal.grid;
  g.lineWidth = 1;
  g.font = 'bold 11px monospace';
  g.fillStyle = pal.label;
  const step = 160;
  for (let x = step, i = 0; x < width; x += step, i++) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
    g.fillText(String.fromCharCode(65 + i), x - step / 2 - 4, 14);
  }
  for (let y = step, j = 1; y < height + step; y += step, j++) {
    if (y < height) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(width, y);
      g.stroke();
    }
    g.fillText(String(j), 6, y - step / 2 + 4);
  }

  // 10. Vignette
  const vig = g.createRadialGradient(
    width / 2,
    height / 2,
    height * 0.35,
    width / 2,
    height / 2,
    width * 0.7,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = vig;
  g.fillRect(0, 0, width, height);

  // ---------- animated overlay ----------
  const clouds = Array.from({ length: 6 }, () => ({
    x: rnd(0, width),
    y: rnd(0, height),
    rx: rnd(90, 200),
    ry: rnd(50, 110),
    speed: rnd(8, 18),
  }));
  let flight: { x: number; y: number; vx: number; vy: number; n: number; scale: number } | null =
    null; // plane shadows crossing the map
  let nextFlight = 2;

  return {
    draw(ctx, time, dt) {
      ctx.drawImage(canvas, 0, 0, width, height);

      for (const c of clouds) {
        c.x += c.speed * dt;
        if (c.x - c.rx > width) c.x = -c.rx;
        const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.rx);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0.14)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.scale(1, c.ry / c.rx);
        ctx.translate(-c.x, -c.y);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      nextFlight -= dt;
      if (!flight && nextFlight <= 0) {
        const fromLeft = Math.random() < 0.5;
        flight = {
          x: fromLeft ? -120 : width + 120,
          y: rnd(height * 0.15, height * 0.85),
          vx: (fromLeft ? 1 : -1) * rnd(140, 220),
          vy: rnd(-30, 30),
          n: 1 + Math.floor(Math.random() * 3),
          scale: rnd(1.2, 1.8),
        };
      }
      if (flight) {
        flight.x += flight.vx * dt;
        flight.y += flight.vy * dt;
        const angle = Math.atan2(flight.vy, flight.vx);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        for (let k = 0; k < flight.n; k++) {
          ctx.save();
          // V formation: wingmen behind and to the side
          const back = k === 0 ? 0 : 50;
          const side = k === 0 ? 0 : k === 1 ? -40 : 40;
          ctx.translate(
            flight.x - Math.cos(angle) * back - Math.sin(angle) * side,
            flight.y - Math.sin(angle) * back + Math.cos(angle) * side,
          );
          ctx.rotate(angle);
          ctx.scale(flight.scale, flight.scale);
          ctx.fill(PLANE_TOP);
          ctx.restore();
        }
        if (flight.x < -300 || flight.x > width + 300) {
          flight = null;
          nextFlight = rnd(4, 9);
        }
      }
    },
  };
}
