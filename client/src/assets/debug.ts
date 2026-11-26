import { HAS_TEST_ENDPOINTS, staticUrl } from './base.ts';
import type { Manifest, ManifestEntry } from './loader.ts';

// URL flags for the failure gallery and timing experiments. They rely on the test endpoints in
// vite.config.js, so they only work under `npm run dev` (ignored anywhere else):
//   ?slow=300        every asset request is delayed by 300 ms (to watch progress / to abort)
//   ?seq=1           load assets sequentially instead of Promise.all (timing experiment)
//   ?fail=404        sprite sheet points to a missing file → vector fallback
//   ?fail=timeout    one sound hangs for 8 s → per-request timeout, retries, then skipped
//   ?fail=flaky      one sound returns 503 twice, then succeeds → retry with backoff recovers
//   ?fail=badjson    an arena file is corrupt JSON → built-in default arena
//   ?fail=manifest   the manifest fails 3 times → error screen with Retry, the retry succeeds
//   ?fail=lobby      the rooms request hangs → lobby request times out, next poll retries
// Flags combine: ?fail=404,flaky&slow=200
// Esc on the loading screen aborts the load (abort mid-load).

export interface DebugFlags {
  slowMs: number;
  readonly sequential: boolean;
  readonly fail: Set<string>;
  readonly demo: string | null;
}

export function readDebugFlags(search = location.search): DebugFlags {
  const q = new URLSearchParams(search);
  const flags: DebugFlags = {
    slowMs: Number(q.get('slow')) || 0,
    sequential: q.get('seq') === '1',
    fail: new Set((q.get('fail') ?? '').split(',').filter(Boolean)),
    demo: q.get('demo'),
  };
  if (!HAS_TEST_ENDPOINTS && (flags.slowMs || flags.fail.size)) {
    console.warn('[debug] ?slow / ?fail need the Vite dev server (npm run dev) — ignored here');
    flags.slowMs = 0;
    flags.fail.clear();
  }
  return flags;
}

/** Wraps an absolute URL in a dev test endpoint: /__delay/300 + /assets/x.wav */
function through(prefix: string, url: string): string {
  const u = new URL(url);
  return `${u.origin}/${prefix}${u.pathname}`;
}
const slow = (url: string, ms: number): string => (ms > 0 ? through(`__delay/${ms}`, url) : url);

export function manifestUrl(flags: DebugFlags): string {
  const url = staticUrl('assets/manifest.json');
  return flags.fail.has('manifest') ? through('__flaky/3', url) : slow(url, flags.slowMs);
}

/** Online: the server's API. Offline (no server found): the static list shipped with the client. */
export function roomsUrl(flags: DebugFlags, apiBase?: string): string {
  const url = apiBase ? `${apiBase}/api/rooms` : staticUrl('offline-rooms.json');
  return flags.fail.has('lobby') ? through('__delay/6000', url) : url;
}

/** Returns a copy of the (already resolved) manifest with debug failures and delays applied. */
export function applyDebugFlags(manifest: Manifest, flags: DebugFlags): Manifest {
  const m = structuredClone(manifest); // deep copy — never mutate what we loaded
  const { fail, slowMs } = flags;

  const { sheet } = m.images;
  const { explode_big: explodeBig, shoot } = m.sounds;
  const { classic } = m.arenas;
  if (fail.has('404') && sheet) sheet.url = staticUrl('assets/sprites/missing-sheet.svg');
  if (fail.has('timeout') && explodeBig) explodeBig.url = through('__delay/8000', explodeBig.url);
  if (fail.has('flaky') && shoot) shoot.url = through('__flaky/2', shoot.url);
  if (fail.has('badjson') && classic) classic.url = `${new URL(classic.url).origin}/__badjson`;

  if (slowMs > 0) {
    for (const entry of manifestEntries(m))
      if (!new URL(entry.url).pathname.startsWith('/__')) entry.url = slow(entry.url, slowMs);
  }
  return m;
}

/** Every { url } entry of a manifest. */
export function manifestEntries(m: Manifest): ManifestEntry[] {
  return [
    ...(m.atlas ? [m.atlas] : []),
    ...Object.values(m.images),
    ...Object.values(m.sounds),
    ...Object.values(m.arenas),
  ];
}
