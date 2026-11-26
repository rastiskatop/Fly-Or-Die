import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Stats } from 'node:fs';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves files from `root` (the built client). Returns true if it handled the request.
 * Path traversal guard: the decoded path is resolved against root and must stay INSIDE it —
 * "/../../etc/passwd", "%2e%2e%2f" and absolute paths all resolve outside and get 403.
 */
export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
) => Promise<boolean>;

export function createStaticHandler(root: string): StaticHandler {
  const rootDir = resolve(root);

  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end('bad path');
      return true;
    }
    if (rel.includes('\0')) {
      res.writeHead(400).end('bad path');
      return true;
    }
    if (rel.endsWith('/')) rel += 'index.html';

    let file = resolve(rootDir, '.' + rel);
    if (file !== rootDir && !file.startsWith(rootDir + sep)) {
      res.writeHead(403).end('forbidden');
      return true;
    }

    let info: Stats;
    try {
      info = await stat(file);
      if (info.isDirectory()) {
        file = resolve(file, 'index.html');
        info = await stat(file);
      }
    } catch {
      return false; // not found → the caller answers 404
    }

    const ext = extname(file).toLowerCase();
    // Vite puts content hashes in built JS names (index-AbC123.js): safe to cache forever.
    const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    // Streamed, not readFile: memory stays flat whatever the file size, and backpressure is
    // handled for slow clients. A client that disconnects mid-download rejects the pipeline —
    // that's normal, not a server error.
    await pipeline(createReadStream(file), res).catch(() => {});
    return true;
  };
}
