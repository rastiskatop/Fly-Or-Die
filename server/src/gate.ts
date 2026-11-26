// The door before a WebSocket exists (Lab 8): who may open one, and how many.
//
// CORS does not apply to WebSockets: any page on any site can `new WebSocket('wss://our.app/ws')`
// and the browser will happily attach our users' cookies. The browser DOES send the page's Origin
// on the handshake, so we check it here (cross-site WebSocket hijacking, OWASP). Clients that are
// not browsers (bots, the load test) send no Origin; they could forge one anyway, so it isn't
// authentication — rate limits and per-IP caps handle those.
import type { IncomingMessage } from 'node:http';

export type GateResult =
  | { readonly ok: true; readonly ip: string }
  | { readonly ok: false; readonly status: 403 | 429; readonly reason: string };

export interface GateConfig {
  readonly allowedOrigins: readonly string[];
  readonly production: boolean;
  readonly trustProxy: boolean;
  readonly maxConnectionsPerIp: number;
}

const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Is this page origin allowed to open a socket to the host it is talking to? */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  cfg: Pick<GateConfig, 'allowedOrigins' | 'production'>,
): boolean {
  if (origin === undefined) return true; // not a browser (see above)
  if (cfg.allowedOrigins.includes(origin)) return true;
  if (cfg.allowedOrigins.length === 0) {
    // Same origin: the page was served by this very host (the normal case: one origin).
    if (host !== undefined && (origin === `https://${host}` || origin === `http://${host}`))
      return true;
    if (!cfg.production && LOCALHOST.test(origin)) return true; // Vite, Live Server on a laptop
  }
  return false;
}

/** The client's IP. Behind a trusted proxy: the LAST X-Forwarded-For entry (the proxy appended it;
 *  anything before it was sent by the client and can be forged). */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const xff = req.headers['x-forwarded-for'];
  if (trustProxy && typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',');
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? '?';
}

/** Counts open connections per IP; `admit` before the upgrade, `release` on close. */
export function createGate(cfg: GateConfig) {
  const perIp = new Map<string, number>();
  return {
    admit(req: IncomingMessage): GateResult {
      const origin = req.headers.origin;
      if (!originAllowed(origin, req.headers.host, cfg))
        return { ok: false, status: 403, reason: 'origin' };
      const ip = clientIp(req, cfg.trustProxy);
      const n = perIp.get(ip) ?? 0;
      if (n >= cfg.maxConnectionsPerIp) return { ok: false, status: 429, reason: 'ip_cap' };
      perIp.set(ip, n + 1);
      return { ok: true, ip };
    },
    release(ip: string): void {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    },
    openFrom(ip: string): number {
      return perIp.get(ip) ?? 0;
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
