// Lab 7, M4: runs client/worker-bench.html in Edge (Vite dev server on :5180) and prints the table.
//   node scripts/worker-bench.ts
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(import.meta.dirname, '..');
const vite = spawn(
  process.execPath,
  [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5180', '--strictPort'],
  {
    cwd: join(root, 'client'),
    stdio: 'ignore',
  },
);
try {
  for (let i = 0; i < 100; i++) {
    const ok = await fetch('http://localhost:5180/worker-bench.html').then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch({
    channel: process.env.CI ? undefined : 'msedge',
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:5180/worker-bench.html');
  await page.waitForFunction(() => window.benchResult !== undefined, undefined, {
    timeout: 120_000,
  });
  const result: unknown = await page.evaluate(() => window.benchResult);
  await browser.close();
  await mkdir(join(root, 'docs', 'lab-07'), { recursive: true });
  await writeFile(
    join(root, 'docs', 'lab-07', 'worker-bench.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  vite.kill();
}

declare global {
  interface Window {
    benchResult?: unknown;
  }
}
