import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Dev-only test endpoints for Lab 3 (failure gallery, slow loading, a "live" rooms list).
// Lab 4 replaces the rooms endpoint with a real Node server.
function devTestApi() {
  const flakyCounts = new Map();
  let rooms = null;

  return {
    name: 'flyordie-dev-test-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        let m;

        // /__delay/<ms>/<path> — wait, then redirect to the real file
        if ((m = path.match(/^\/__delay\/(\d+)\/(.*)$/))) {
          const timer = setTimeout(() => {
            res.statusCode = 307;
            res.setHeader('Location', `/${m[2]}`);
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
          const key = m[2];
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

        // /__badjson — 200 OK with a truncated body
        if (path === '/__badjson') {
          res.setHeader('Content-Type', 'application/json');
          res.end('{ "id": "classic", "name": "Clas');
          return;
        }

        // /api/rooms.json — static file in production; in dev the player counts drift
        // so the lobby's periodic refresh has something to show.
        if (path === '/api/rooms.json') {
          if (!rooms) rooms = JSON.parse(readFileSync('public/api/rooms.json', 'utf8')).rooms;
          for (const r of rooms) {
            if (r.players >= r.maxPlayers && Math.random() < 0.7) continue; // full rooms stay full-ish
            const step = Math.floor(Math.random() * 3) - 1;
            r.players = Math.max(0, Math.min(r.maxPlayers, r.players + step));
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ rooms, serverTime: Date.now() }));
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  // No SPA fallback: a missing file must be a real 404, not index.html with 200 OK
  // (found in the failure gallery — the 404 sprite first showed up as "cannot decode").
  appType: 'mpa',
  // Relative base: the build works from any sub-path (GitHub Pages, a folder on any host).
  base: './',
  plugins: [devTestApi()],
});
