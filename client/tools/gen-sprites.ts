// Generates the sprite sheet (SVG) and its atlas (JSON) — one image, many frames.
// Run: node tools/gen-sprites.mjs → public/assets/sprites/sheet.svg + sheet.json
// The sheet is drawn at 2x so it stays crisp on HiDPI screens; atlas.scale = 2.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'sprites');
mkdirSync(outDir, { recursive: true });

const SCALE = 2;
const PLANE_SCALE = 1.3 * SCALE; // same proportions as the Lab 2 vector plane
interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  ax: number;
  ay: number;
  radius?: number;
}
const frames: Record<string, Frame> = {};
const parts: string[] = [];

function frame(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  ax: number,
  ay: number,
  extra: { radius?: number } = {},
): void {
  frames[name] = { x, y, w, h, ax, ay, ...extra };
}

// ---------- plane ----------
const planeDefs = `
  <g id="plane-body" stroke-width="1.5" stroke-linejoin="round">
    <path d="M6 0 L-4 -17 L-9 -17 L-6 -3 L-6 3 L-9 17 L-4 17 Z"/>
    <path d="M-9 0 L-15 -8 L-18 -8 L-15 0 L-18 8 L-15 8 Z"/>
    <path d="M20 0 Q12 -4 2 -4 L-15 -3 L-15 3 L2 4 Q12 4 20 0 Z"/>
    <ellipse cx="17.5" cy="0" rx="2.6" ry="2" fill="#e0b020" stroke="none"/>
    <rect x="-6.2" y="-13.5" width="2.6" height="5" fill="#e0b020" stroke="none" transform="rotate(-28 -5 -11)"/>
    <rect x="-6.2" y="8.5" width="2.6" height="5" fill="#e0b020" stroke="none" transform="rotate(28 -5 11)"/>
    <ellipse cx="8" cy="0" rx="4.5" ry="2" fill="#7fdcff" stroke="none"/>
    <rect x="-7.5" y="-17.5" width="2" height="2" fill="#ff3b3b" stroke="none"/>
    <rect x="-7.5" y="15.5" width="2" height="2" fill="#3bff6e" stroke="none"/>
  </g>`;

function flame(len: number, outer: string, inner: string): string {
  return `<path d="M-14 -3 L${-14 - 14 * len} 0 L-14 3 Z" fill="${outer}"/>
    <path d="M-14 -1.5 L${-14 - 7 * len} 0 L-14 1.5 Z" fill="${inner}"/>`;
}

function plane(
  name: string,
  col: number,
  row: number,
  // Military steel-grey with a dark outline and yellow ID markings: readable on grass, sand and snow.
  {
    flameLen = 0,
    outer = '',
    inner = '',
    fill = '#b9c2c6',
    stroke = '#1b2023',
  }: { flameLen?: number; outer?: string; inner?: string; fill?: string; stroke?: string },
): void {
  const x = col * 192;
  const y = row * 128;
  const ax = 104;
  const ay = 64;
  parts.push(`<g transform="translate(${x + ax} ${y + ay}) scale(${PLANE_SCALE})">
    ${flameLen ? flame(flameLen, outer, inner) : ''}
    <use href="#plane-body" fill="${fill}" stroke="${stroke}"/>
  </g>`);
  frame(name, x, y, 192, 128, ax, ay);
}

plane('ship', 0, 0, {});
plane('ship_thrust_a', 1, 0, { flameLen: 1.15, outer: '#ff7a1a', inner: '#ffe08a' });
plane('ship_thrust_b', 2, 0, { flameLen: 0.8, outer: '#ff7a1a', inner: '#ffe08a' });
plane('ship_boost_a', 3, 0, { flameLen: 1.6, outer: '#4fc3ff', inner: '#e6fbff' });
plane('ship_boost_b', 4, 0, { flameLen: 1.2, outer: '#4fc3ff', inner: '#e6fbff' });
plane('ship_hit', 0, 1, { fill: '#ff4d4d', stroke: '#ffffff' });

// ---------- asteroids ----------
let seed = 7;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const ROCK_R = 56;
['asteroid_a', 'asteroid_b', 'asteroid_c'].forEach((name, i) => {
  const x = 192 + i * 128;
  const y = 128;
  const cx = x + 64;
  const cy = y + 64;
  const n = 11 + i;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    const r = ROCK_R * (0.78 + rnd() * 0.27);
    pts.push(`${(cx + Math.cos(t) * r).toFixed(1)},${(cy + Math.sin(t) * r).toFixed(1)}`);
  }
  // A few craters for texture.
  const craters = Array.from({ length: 3 }, () => {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * ROCK_R * 0.45;
    const cr = 5 + rnd() * 8;
    return `<circle cx="${(cx + Math.cos(a) * d).toFixed(1)}" cy="${(cy + Math.sin(a) * d).toFixed(1)}" r="${cr.toFixed(1)}" fill="#1a1613" stroke="#6e604f" stroke-width="2"/>`;
  }).join('');
  parts.push(
    `<polygon points="${pts.join(' ')}" fill="#221d19" stroke="#c8b49a" stroke-width="4" stroke-linejoin="round"/>${craters}`,
  );
  frame(name, x, y, 128, 128, 64, 64, { radius: ROCK_R });
});

// ---------- pickups ----------
function hexagon(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, k) => {
    const t = (k / 6) * Math.PI * 2;
    return `${(cx + Math.cos(t) * r).toFixed(1)},${(cy + Math.sin(t) * r).toFixed(1)}`;
  }).join(' ');
}
const pickups: readonly (readonly [
  name: string,
  color: string,
  icon: (cx: number, cy: number) => string,
])[] = [
  // » double chevron = speed
  [
    'pickup_speed',
    '#4fc3ff',
    (cx, cy) =>
      `<path d="M${cx - 11} ${cy - 9} L${cx - 2} ${cy} L${cx - 11} ${cy + 9} M${cx} ${cy - 9} L${cx + 9} ${cy} L${cx} ${cy + 9}" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
  ],
  // bullet with speed lines = bullets x2
  [
    'pickup_bullets',
    '#ffd23f',
    (cx, cy) =>
      `<path d="M${cx - 4} ${cy - 5} L${cx + 6} ${cy - 5} Q${cx + 13} ${cy} ${cx + 6} ${cy + 5} L${cx - 4} ${cy + 5} Z" stroke="none"/><path d="M${cx - 14} ${cy - 4} L${cx - 8} ${cy - 4} M${cx - 16} ${cy + 4} L${cx - 8} ${cy + 4}" stroke-width="3" stroke-linecap="round"/>`,
  ],
  // + cross = repair
  [
    'pickup_repair',
    '#5dff7a',
    (cx, cy) =>
      `<path d="M${cx - 4} ${cy - 12} h8 v8 h8 v8 h-8 v8 h-8 v-8 h-8 v-8 h8 Z" stroke="none"/>`,
  ],
];
pickups.forEach(([name, color, icon], i) => {
  const x = i * 96;
  const y = 256;
  const cx = x + 48;
  const cy = y + 48;
  parts.push(`<g filter="url(#glow)">
    <polygon points="${hexagon(cx, cy, 24)}" fill="rgba(0,0,0,0.6)" stroke="${color}" stroke-width="4"/>
    <g fill="${color}" stroke="${color}">${icon(cx, cy)}</g>
  </g>`);
  frame(name, x, y, 96, 96, 48, 48, { radius: 24 });
});

// ---------- bullets ----------
// Glowing capsules, not <line>s: an SVG filter on a horizontal line has a zero-height bounding
// box → zero-size filter region → the line isn't drawn at all (that's why bullets were invisible).
// The bullet filter also uses userSpaceOnUse so its region never depends on the shape's bbox.
function bullet(name: string, y: number, len: number, halo: string, core: string): void {
  const x = 288;
  const h = 24;
  const cy = y + h / 2;
  const x0 = x + 8;
  parts.push(`<g filter="url(#glow-bullet)">
    <rect x="${x0}" y="${cy - 5}" width="${len}" height="10" rx="5" fill="${halo}"/>
    <rect x="${x0 + len * 0.35}" y="${cy - 2.5}" width="${len * 0.6}" height="5" rx="2.5" fill="${core}"/>
  </g>`);
  frame(name, x, y, len + 22, h, 8 + len - 6, h / 2); // anchor near the tip, like the Lab 2 line
}
bullet('bullet', 256, 34, '#ffc21a', '#ffffff');
bullet('bullet_fast', 288, 62, '#4fe3ff', '#ffffff');

const W = 960;
const H = 352;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <filter id="glow-bullet" filterUnits="userSpaceOnUse" x="280" y="248" width="200" height="72">
    <feGaussianBlur stdDeviation="2.5" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="3" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  ${planeDefs}
</defs>
${parts.join('\n')}
</svg>
`;

writeFileSync(join(outDir, 'sheet.svg'), svg);
writeFileSync(
  join(outDir, 'sheet.json'),
  JSON.stringify({ image: 'sheet', scale: SCALE, frames }, null, 2) + '\n',
);
console.log(`sheet.svg ${W}x${H}, ${Object.keys(frames).length} frames`);
