import { fetchJson } from '../assets/net.ts';
import { HealthSchema } from '@flyordie/shared/net/messages.ts';

export interface ServerLocation {
  readonly apiBase: string;
  readonly wsUrl: string;
}

const DEFAULT_SERVER_PORT = 8787;

/**
 * Finds the game server. Tries, in order:
 *  1. the page's own origin — the Node server serving the build, or Vite proxying /health,/api,/ws
 *  2. http://<same host>:8787 — the page comes from VS Code Live Server / another static server
 * Returns { apiBase, wsUrl } or null → offline mode (local game, no chat).
 */
export async function findServer({
  timeoutMs = 1500,
}: { timeoutMs?: number } = {}): Promise<ServerLocation | null> {
  const candidates = [location.origin];
  if (location.port !== String(DEFAULT_SERVER_PORT)) {
    candidates.push(`${location.protocol}//${location.hostname}:${DEFAULT_SERVER_PORT}`);
  }
  for (const origin of candidates) {
    try {
      // The schema checks it's really OUR server (status ok, service flyordie), not any 200 OK.
      if (HealthSchema.safeParse(await fetchJson(`${origin}/health`, { timeoutMs })).success) {
        const ws = new URL('/ws', origin);
        ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
        return { apiBase: origin, wsUrl: ws.href };
      }
    } catch {
      // not here — try the next candidate
    }
  }
  return null;
}
