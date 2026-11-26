// Rasterizes public/icons/icon.svg into the PNG icons a PWA needs (Lab 8), in a real browser:
//   node tools/gen-icons.ts        (uses the installed Edge locally, Chromium in CI)
// 192/512 "any" icons, a 512 "maskable" one (padded into the 80 % safe zone) and Apple's 180.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const dir = join(import.meta.dirname, '..', 'public', 'icons');
const svg = await readFile(join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch({
  channel: process.env.CI ? undefined : 'msedge',
  headless: true,
});
const page = await browser.newPage();

async function render(size: number, padding: number): Promise<Buffer> {
  const dataUrl: string = await page.evaluate(
    async ({ svg, size, padding }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.fillStyle = '#3b4423'; // maskable: the background fills the whole square
      g.fillRect(0, 0, size, size);
      const inner = size * (1 - 2 * padding);
      g.drawImage(img, size * padding, size * padding, inner, inner);
      return c.toDataURL('image/png');
    },
    { svg, size, padding },
  );
  return Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
}

const out: [name: string, size: number, padding: number][] = [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 0.1],
  ['apple-touch-icon.png', 180, 0],
];
for (const [name, size, padding] of out) {
  const png = await render(size, padding);
  await writeFile(join(dir, name), png);
  console.log(`${name}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
await browser.close();
