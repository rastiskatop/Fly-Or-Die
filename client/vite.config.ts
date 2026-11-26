import { defineConfig, type Plugin } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, sep } from 'node:path';

/** "0.8.0+a1b2c3d": GIT_SHA (Docker build arg) / RENDER_GIT_COMMIT, else the local checkout. */
function appVersion(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
  );
  const semver =
    typeof pkg === 'object' && pkg && 'version' in pkg && typeof pkg.version === 'string'
      ? pkg.version
      : '0.0.0';
  let sha = process.env.GIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? '';
  if (!sha) {
    try {
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      sha = 'dev'; // no git (e.g. a source tarball)
    }
  }
  return `${semver}+${sha.slice(0, 7)}`;
}

// Dev-only test endpoints for the Lab 3 failure gallery (slow loading, flaky files, bad JSON).
// The real API (/api, /health) and the WebSocket (/ws) live in the Node server (server/),
// Vite proxies them in development so the browser sees ONE origin.
function devTestApi(): Plugin {
  const flakyCounts = new Map<string, number>();

  return {
    name: 'flyordie-dev-test-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        let m: RegExpMatchArray | null;

        // /__delay/<ms>/<path> — wait, then redirect to the real file
        if ((m = path.match(/^\/__delay\/(\d+)\/(.*)$/))) {
          const target = m[2] ?? '';
          const timer = setTimeout(() => {
            res.statusCode = 307;
            res.setHeader('Location', `/${target}`);
            res.end();
          }, Number(m[1]));
          req.on('close', () => clearTimeout(timer)); // client aborted
          return;
        }

        // /__status/<code>/<path> — always answer with that status
        if ((m = path.match(/^\/__status\/(\d+)\//))) {
          res.statusCode = Number(m[1]);
          res.end(`forced status ${m[1]}`);
          return;
        }

        // /__flaky/<n>/<path> — 503 for the first n requests, then the real file
        if ((m = path.match(/^\/__flaky\/(\d+)\/(.*)$/))) {
          const key = m[2] ?? '';
          const count = (flakyCounts.get(key) ?? 0) + 1;
          if (count <= Number(m[1])) {
            flakyCounts.set(key, count);
            res.statusCode = 503;
            res.end('service unavailable (flaky test endpoint)');
          } else {
            flakyCounts.delete(key); // next page load fails again
            res.statusCode = 307;
            res.setHeader('Location', `/${key}`);
            res.end();
          }
          return;
        }

        // POST /__save/<file> — dev-only: the duel recorder (duel.html) saves its GIF into docs/
        if (req.method === 'POST' && path.startsWith('/__save/')) {
          const docs = resolve(import.meta.dirname, '..', 'docs');
          const target = resolve(docs, decodeURIComponent(path.slice('/__save/'.length)));
          if (!target.startsWith(docs + sep) || !/.(gif|png)$/.test(target)) {
            res.statusCode = 403;
            res.end('only docs/*.gif|png');
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          // A failed write used to be an unhandled rejection and a request that never answered.
          req.on('end', () => {
            mkdir(dirname(target), { recursive: true })
              .then(() => writeFile(target, Buffer.concat(chunks)))
              .then(
                () => res.end(`saved ${target}`),
                (err: unknown) => {
                  res.statusCode = 500;
                  res.end(`save failed: ${err instanceof Error ? err.message : 'unknown error'}`);
                },
              );
          });
          return;
        }

        // /__badjson — 200 OK with a truncated body
        if (path === '/__badjson') {
          res.setHeader('Content-Type', 'application/json');
          res.end('{ "id": "classic", "name": "Clas');
          return;
        }

        next();
      });
    },
  };
}

const SERVER = `http://127.0.0.1:${process.env.SERVER_PORT ?? 8787}`;

export default defineConfig({
  // No SPA fallback: a missing file must be a real 404, not index.html with 200 OK
  // (found in the failure gallery — the 404 sprite first showed up as "cannot decode").
  appType: 'mpa',
  // Relative base: the build works from any sub-path (GitHub Pages, a folder on any host).
  base: './',
  plugins: [devTestApi()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  // Two pages in the production build: the game and the live metrics dashboard (Lab 8).
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        dashboard: resolve(import.meta.dirname, 'dashboard.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': SERVER,
      '/health': SERVER,
      '/ready': SERVER,
      '/metrics': SERVER,
      '/ws': { target: SERVER, ws: true },
    },
  },
});
