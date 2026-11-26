// End-to-end: real browsers, real server, real protocol. `npm run e2e`.
// Locally it drives the installed Microsoft Edge (no browser download); CI installs Chromium.
import { defineConfig } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    ...(CI ? {} : { channel: 'msedge' }),
    trace: 'retain-on-failure',
  },
  // `npm run dev`: the game server on :8787 + Vite on :5173 (dev build exposes window.net).
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
