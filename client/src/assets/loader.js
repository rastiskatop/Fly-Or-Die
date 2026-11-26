import { shortUrl } from './base.js';
import { fetchChecked, fetchJson, withRetry, describeError, createLimiter } from './net.js';

const TIMEOUT_MS = 2500; // per request attempt
const RETRY = { attempts: 3, baseMs: 250, maxMs: 2000 };
const MAX_PARALLEL = 6; // = the browser's HTTP/1.1 connections per host

/**
 * Downloads an image and waits until it is decoded.
 * We fetch() instead of setting img.src directly because fetch gives us an HTTP status
 * (img.onerror can't tell 404 from a network error), AbortSignal support and timeouts.
 */
export async function loadImage(url, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetchChecked(url, { signal, timeoutMs });
  const blob = await res.blob();
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode(); // async decode: no jank on first drawImage
  return img;
}

/** fetch → ArrayBuffer → decodeAudioData → AudioBuffer (decoded once, played many times). */
export async function loadAudio(audioCtx, url, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetchChecked(url, { signal, timeoutMs });
  const bytes = await res.arrayBuffer();
  if (!audioCtx) return null; // no Web Audio in this browser: load nothing, play nothing
  return audioCtx.decodeAudioData(bytes);
}

export function loadJson(url, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  return fetchJson(url, { signal, timeoutMs });
}

/** Flattens the manifest into a list of load tasks. */
function tasksFromManifest(manifest, audioCtx) {
  const tasks = [];
  const add = (group, key, entry, loader) =>
    tasks.push({ group, key, url: entry.url, critical: Boolean(entry.critical), loader });

  if (manifest.atlas) add('atlas', 'atlas', manifest.atlas, loadJson);
  for (const [key, entry] of Object.entries(manifest.images ?? {}))
    add('images', key, entry, loadImage);
  for (const [key, entry] of Object.entries(manifest.sounds ?? {}))
    add('sounds', key, entry, (url, opts) => loadAudio(audioCtx, url, opts));
  for (const [key, entry] of Object.entries(manifest.arenas ?? {}))
    add('arenas', key, entry, loadJson);
  return tasks;
}

/**
 * Loads every asset of the manifest.
 * - concurrent (Promise.all) by default, `sequential: true` for the timing experiment;
 * - per-item progress via onProgress (Promise.all alone reports nothing until the end);
 * - each item retried with backoff on transient errors;
 * - optional items that fail are recorded in `failures` and the game continues with a fallback;
 *   a critical failure or an abort rejects the whole load.
 */
export async function loadAll(
  manifest,
  { audioCtx, onProgress, signal, sequential = false, log = console } = {},
) {
  const tasks = tasksFromManifest(manifest, audioCtx);
  const result = {
    atlas: null,
    images: {},
    sounds: {},
    arenas: {},
    failures: [],
    retries: 0,
    ms: 0,
  };
  const total = tasks.length;
  let done = 0;
  const limit = createLimiter(MAX_PARALLEL);
  const started = performance.now();
  onProgress?.({ done, total, task: null, status: 'start' });

  async function run(task) {
    try {
      const value = await withRetry(() => limit(() => task.loader(task.url, { signal })), {
        ...RETRY,
        signal,
        onRetry: ({ attempt, delay, error }) => {
          result.retries++;
          log.warn(
            `[assets] ${shortUrl(task.url)}: ${describeError(error)}, retry #${attempt} in ${delay} ms`,
          );
          onProgress?.({ done, total, task, status: 'retry', error });
        },
      });
      if (task.group === 'atlas') result.atlas = value;
      else result[task.group][task.key] = value;
      done++;
      onProgress?.({ done, total, task, status: 'ok' });
      return value;
    } catch (error) {
      // Abort and critical failures propagate and reject Promise.all.
      if (error?.name === 'AbortError' || task.critical) throw error;
      result.failures.push({ ...task, error, reason: describeError(error) });
      log.warn(
        `[assets] FAILED ${shortUrl(task.url)}: ${describeError(error)} — continuing with fallback`,
      );
      done++;
      onProgress?.({ done, total, task, status: 'failed', error });
      return null;
    }
  }

  if (sequential) {
    for (const task of tasks) await run(task); // each request starts only after the previous one ends
  } else {
    await Promise.all(tasks.map(run)); // all requests start now
  }

  result.ms = Math.round(performance.now() - started);
  log.info(
    `[assets] ${total} assets in ${result.ms} ms (${sequential ? 'sequential' : 'concurrent'}), ` +
      `${result.failures.length} failed, ${result.retries} retries`,
  );
  return result;
}
