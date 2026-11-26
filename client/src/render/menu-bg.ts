import { drawFighterSide, drawRifle, drawGrenade, drawCartridge, drawBomb } from './art.ts';

/**
 * Animated war-time backdrop for the loading screen and the lobby (full-window canvas behind them):
 * dusk sky, a burning skyline with smoke, flak bursts, searchlights, fighters with contrails,
 * and weapons tumbling through the air. Render-only — nothing here touches the simulation.
 * start()/stop() so it costs nothing during a match.
 */
type Ridge = [x: number, y: number][];
interface Smoke {
  readonly x: number;
  readonly y: number;
  readonly born: number;
  readonly r: number;
  readonly drift: number;
}
interface Flak {
  readonly x: number;
  readonly y: number;
  readonly born: number;
  readonly r: number;
}
interface Plane {
  readonly dir: 1 | -1;
  readonly depth: number;
  x: number;
  y: number;
  readonly vy: number;
  readonly speed: number;
  readonly wobble: number;
  readonly trail: [number, number][];
}
interface Item {
  readonly draw: (ctx: CanvasRenderingContext2D, alpha: number) => void;
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  rot: number;
  readonly vr: number;
  readonly scale: number;
  readonly alpha: number;
}

/** In-place filter: removes the elements matching `pred` (keeps the array identity). */
function removeWhere<T>(arr: T[], pred: (x: T) => boolean): void {
  let kept = 0;
  for (const x of arr) if (!pred(x)) arr[kept++] = x;
  arr.length = kept;
}

export interface MenuBackground {
  start(): void;
  stop(): void;
}

export function createMenuBackground(canvas: HTMLCanvasElement): MenuBackground {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas not supported');
  const ctx = context;
  let w = 0;
  let h = 0;
  let raf = 0;
  let last = 0;
  let ridgeFar: Ridge = [];
  let ridgeNear: Ridge = [];

  const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ridgeFar = ridge(0.72, 40, 0.012);
    ridgeNear = ridge(0.82, 26, 0.03, true);
  }

  // Skyline: hills plus blocky ruins / chimneys on the near ridge.
  function ridge(base: number, amp: number, freq: number, buildings = false): Ridge {
    const pts: Ridge = [];
    const phase = Math.random() * 100;
    for (let x = -20; x <= w + 40; x += 20) {
      let y = h * base - Math.sin(x * freq + phase) * amp - Math.sin(x * freq * 2.7) * amp * 0.4;
      if (buildings && Math.random() < 0.35) y -= rnd(14, 60);
      pts.push([x, y]);
    }
    return pts;
  }

  const smoke: Smoke[] = []; // rising plumes from the burning city
  const flak: Flak[] = []; // short-lived bursts in the sky
  const planes: Plane[] = [];
  const items: Item[] = [];
  const DRAW_ITEM = [drawRifle, drawGrenade, drawCartridge, drawBomb, drawRifle];

  function spawnPlane(initial = false): void {
    const dir: 1 | -1 = Math.random() < 0.7 ? 1 : -1;
    const depth = rnd(0.35, 1); // smaller + slower = farther away
    planes.push({
      dir,
      depth,
      x: initial ? rnd(0, w) : dir > 0 ? -120 : w + 120,
      y: rnd(h * 0.08, h * 0.55),
      vy: rnd(-6, 6),
      speed: (80 + 160 * depth) * dir,
      wobble: rnd(0, 6),
      trail: [],
    });
  }

  function spawnItem(initial = false): void {
    items.push({
      draw: DRAW_ITEM[Math.floor(Math.random() * DRAW_ITEM.length)] ?? drawRifle,
      x: rnd(0, w),
      y: initial ? rnd(0, h) : h + 60,
      vx: rnd(-18, 18),
      vy: rnd(-42, -16),
      rot: rnd(0, Math.PI * 2),
      vr: rnd(-0.8, 0.8),
      scale: rnd(0.6, 1.25),
      alpha: rnd(0.35, 0.75),
    });
  }

  function update(dt: number, t: number): void {
    while (planes.length < Math.max(3, Math.round(w / 380))) spawnPlane();
    for (const p of planes) {
      p.x += p.speed * dt;
      p.y += (p.vy + Math.sin(t * 0.8 + p.wobble) * 8) * dt;
      p.trail.push([p.x - p.dir * 30 * p.depth, p.y]);
      if (p.trail.length > 60) p.trail.shift();
    }
    removeWhere(planes, (p) => p.x < -300 || p.x > w + 300);

    while (items.length < Math.max(10, Math.round((w * h) / 90000))) spawnItem();
    for (const it of items) {
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.rot += it.vr * dt;
    }
    removeWhere(items, (it) => it.y < -80);

    if (Math.random() < dt * 1.6) {
      flak.push({ x: rnd(w * 0.05, w * 0.95), y: rnd(h * 0.06, h * 0.5), born: t, r: rnd(10, 22) });
    }
    removeWhere(flak, (f) => t - f.born > 2.5);

    if (Math.random() < dt * 10) {
      const src = ridgeNear[Math.floor(rnd(0, ridgeNear.length))];
      if (src)
        smoke.push({
          x: src[0] + rnd(-10, 10),
          y: src[1],
          born: t,
          r: rnd(8, 16),
          drift: rnd(6, 20),
        });
    }
    removeWhere(smoke, (s) => t - s.born > 9);
  }

  function drawRidge(pts: Ridge, color: string): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-20, h);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(w + 40, h);
    ctx.closePath();
    ctx.fill();
  }

  function draw(t: number): void {
    // Dusk sky
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#141a22');
    sky.addColorStop(0.45, '#3a3430');
    sky.addColorStop(0.72, '#a2502a');
    sky.addColorStop(0.85, '#d27a35');
    sky.addColorStop(1, '#2a1a12');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Low sun with glow
    const sx = w * 0.72;
    const sy = h * 0.7;
    const glow = ctx.createRadialGradient(sx, sy, 10, sx, sy, h * 0.6);
    glow.addColorStop(0, 'rgba(255, 196, 110, 0.55)');
    glow.addColorStop(1, 'rgba(255, 120, 40, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffd08a';
    ctx.beginPath();
    ctx.arc(sx, sy, 34, 0, Math.PI * 2);
    ctx.fill();

    // Searchlights sweeping from the ground
    for (let i = 0; i < 3; i++) {
      const bx = w * (0.18 + i * 0.3);
      const ang = -Math.PI / 2 + Math.sin(t * 0.35 + i * 2.1) * 0.55;
      const len = h * 0.9;
      ctx.save();
      ctx.translate(bx, h * 0.86);
      ctx.rotate(ang);
      const beam = ctx.createLinearGradient(0, 0, len, 0);
      beam.addColorStop(0, 'rgba(255, 245, 210, 0.16)');
      beam.addColorStop(1, 'rgba(255, 245, 210, 0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(0, -3);
      ctx.lineTo(len, -46);
      ctx.lineTo(len, 46);
      ctx.lineTo(0, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Flak bursts: flash, then a dark puff that fades
    for (const f of flak) {
      const age = t - f.born;
      if (age < 0.12) {
        ctx.fillStyle = 'rgba(255, 220, 140, 0.9)';
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(30, 28, 26, ${0.55 * (1 - age / 2.5)})`;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.arc(
          f.x + Math.cos(k * 1.7) * f.r * 0.5,
          f.y + Math.sin(k * 2.3) * f.r * 0.4,
          f.r * (0.6 + age * 0.35),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }

    drawRidge(ridgeFar, '#2b2420');

    // Planes (farther ones first), each with a fading contrail
    for (const p of [...planes].sort((a, b) => a.depth - b.depth)) {
      ctx.strokeStyle = `rgba(235, 230, 220, ${0.25 * p.depth})`;
      ctx.lineWidth = 2 * p.depth;
      ctx.beginPath();
      p.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(p.dir * p.depth * 1.3, p.depth * 1.3);
      ctx.rotate(Math.sin(t * 0.8 + p.wobble) * 0.06);
      const shade = Math.round(20 + (1 - p.depth) * 50);
      drawFighterSide(ctx, `rgb(${shade}, ${shade + 4}, ${shade + 8})`);
      ctx.restore();
    }

    // Smoke columns from the burning skyline
    for (const s of smoke) {
      const age = t - s.born;
      ctx.fillStyle = `rgba(40, 36, 34, ${0.35 * (1 - age / 9)})`;
      ctx.beginPath();
      ctx.arc(s.x + age * s.drift, s.y - age * 22, s.r + age * 6, 0, Math.PI * 2);
      ctx.fill();
    }
    drawRidge(ridgeNear, '#16120f');
    // Fires along the skyline
    for (let i = 0; i < ridgeNear.length; i += 7) {
      const point = ridgeNear[i];
      if (!point) continue;
      const [x, y] = point;
      const flick = 0.6 + 0.4 * Math.sin(t * 9 + i);
      ctx.fillStyle = `rgba(255, ${Math.round(120 + 60 * flick)}, 40, ${0.5 * flick})`;
      ctx.beginPath();
      ctx.ellipse(x, y + 2, 7 + 3 * flick, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Weapons tumbling through the air (foreground)
    for (const it of items) {
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate(it.rot);
      ctx.scale(it.scale, it.scale);
      it.draw(ctx, it.alpha);
      ctx.restore();
    }

    // Vignette
    const vig = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.35,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.75,
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  function frame(now: number): void {
    const t = now / 1000;
    const dt = Math.min(0.05, last ? t - last : 0);
    last = t;
    update(dt, t);
    draw(t);
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  for (let i = 0; i < 4; i++) spawnPlane(true);
  for (let i = 0; i < 12; i++) spawnItem(true);

  return {
    start() {
      if (raf) return;
      canvas.hidden = false;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      canvas.hidden = true;
    },
  };
}
