// Generates the game's sound effects as 16-bit mono WAV files (no external assets, no deps).
// Run: node tools/gen-sounds.mjs   → writes public/assets/sounds/*.wav
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RATE = 22050;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'sounds');
mkdirSync(outDir, { recursive: true });

// Deterministic noise so regenerating gives byte-identical files.
let seed = 12345;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
};

function render(seconds, fn) {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / RATE, i / n);
  return out;
}

function writeWav(name, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(join(outDir, `${name}.wav`), Buffer.concat([h, data]));
  console.log(`${name}.wav  ${((44 + data.length) / 1024) | 0} KB`);
}

const square = (phase) => (phase % 1 < 0.5 ? 1 : -1);

// Laser "pew": square wave with a fast downward pitch sweep.
{
  let phase = 0;
  writeWav(
    'shoot',
    render(0.13, (t, p) => {
      phase += (1100 - 850 * p) / RATE;
      return square(phase) * 0.35 * Math.pow(1 - p, 2);
    }),
  );
}

// Faster tracer: higher, shorter.
{
  let phase = 0;
  writeWav(
    'shoot_fast',
    render(0.1, (t, p) => {
      phase += (1700 - 1200 * p) / RATE;
      return square(phase) * 0.3 * Math.pow(1 - p, 2);
    }),
  );
}

// Hit: short noise tick + low thump.
writeWav(
  'hit',
  render(
    0.09,
    (t, p) => (noise() * 0.5 + Math.sin(2 * Math.PI * 160 * t) * 0.6) * Math.pow(1 - p, 3),
  ),
);

// Explosions: low-passed noise with exponential decay (one-pole filter = "brown-ish" rumble).
function boom(seconds, cutoff, gain) {
  let y = 0;
  const a = Math.exp((-2 * Math.PI * cutoff) / RATE);
  return render(seconds, (t, p) => {
    y = a * y + (1 - a) * noise();
    return y * gain * Math.exp(-4 * p) * (p < 0.01 ? p / 0.01 : 1);
  });
}
writeWav('explode', boom(0.55, 900, 3.2));
writeWav('explode_big', boom(1.3, 350, 5.5));

// Pickup: rising arpeggio.
writeWav(
  'pickup',
  render(0.3, (t) => {
    const notes = [660, 880, 1320];
    const k = Math.min(2, Math.floor(t / 0.08));
    const local = t - k * 0.08;
    return Math.sin(2 * Math.PI * notes[k] * t) * 0.4 * Math.exp(-local * 12);
  }),
);

// Respawn: smooth upward sweep.
{
  let phase = 0;
  writeWav(
    'respawn',
    render(0.45, (t, p) => {
      phase += (260 + 700 * p * p) / RATE;
      return Math.sin(2 * Math.PI * phase) * 0.35 * Math.sin(Math.PI * p);
    }),
  );
}
