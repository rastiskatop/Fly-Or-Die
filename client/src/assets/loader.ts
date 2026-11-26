import { z } from 'zod';
import { shortUrl } from './base.ts';
import {
  fetchChecked,
  fetchJson,
  withRetry,
  describeError,
  createLimiter,
  type RequestOptions,
} from './net.ts';
import { AtlasSchema, type Atlas } from '../render/sprites.ts';
import { ArenaSchema, type ArenaRules } from '@flyordie/shared/sim/arena.ts';

const TIMEOUT_MS = 2500; // per request attempt
const RETRY = { attempts: 3, baseMs: 250, maxMs: 2000 };
const MAX_PARALLEL = 6; // = the browser's HTTP/1.1 connections per host

// ---------- the manifest is input too: validate it ----------
const EntrySchema = z.object({ url: z.string().min(1), critical: z.boolean().optional() });
export const ManifestSchema = z.object({
  version: z.number().optional(),
  atlas: EntrySchema.optional(),
  images: z.record(z.string(), EntrySchema).default({}),
  sounds: z.record(z.string(), EntrySchema).default({}),
  arenas: z.record(z.string(), EntrySchema).default({}),
});
export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestEntry = z.infer<typeof EntrySchema>;

/**
 * Downloads an image and waits until it is decoded.
 * fetch() instead of img.src: an HTTP status (img.onerror can't tell 404 from a network error),
 * AbortSignal support and timeouts.
 */
export async function loadImage(
  url: string,
  { signal, timeoutMs = TIMEOUT_MS }: RequestOptions = {},
): Promise<HTMLImageElement> {
  const res = await fetchChecked(url, { signal, timeoutMs });
  const blob = await res.blob();
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode(); // async decode: no jank on first drawImage
  return img;
}

/** fetch → ArrayBuffer → decodeAudioData → AudioBuffer (decoded once, played many times). */
export async function loadAudio(
  audioCtx: AudioContext | null,
  url: string,
  { signal, timeoutMs = TIMEOUT_MS }: RequestOptions = {},
): Promise<AudioBuffer | null> {
  const res = await fetchChecked(url, { signal, timeoutMs });
  const bytes = await res.arrayBuffer();
  if (!audioCtx) return null; // no Web Audio in this browser: load nothing, play nothing
  return audioCtx.decodeAudioData(bytes);
}

/** Fetches JSON and parses it with `schema`: the result is typed AND checked. */
export async function loadJson<T>(
  url: string,
  schema: z.ZodType<T>,
  { signal, timeoutMs = TIMEOUT_MS }: RequestOptions = {},
): Promise<T> {
  return schema.parse(await fetchJson(url, { signal, timeoutMs }));
}

export interface LoadedAssets {
  atlas: Atlas | null;
  readonly images: Record<string, HTMLImageElement>;
  readonly sounds: Record<string, AudioBuffer | null>;
  readonly arenas: Record<string, ArenaRules>;
  readonly failures: LoadFailure[];
  retries: number;
  ms: number;
}

/** A load task: what to fetch, and how to put the result where it belongs. */
export interface LoadTask {
  readonly group: 'atlas' | 'images' | 'sounds' | 'arenas';
  readonly key: string;
  readonly url: string;
  readonly critical: boolean;
  readonly load: (signal: AbortSignal | undefined) => Promise<void>;
}

export interface LoadFailure extends LoadTask {
  readonly error: unknown;
  readonly reason: string;
}

export type LoadStatus = 'start' | 'ok' | 'retry' | 'failed';
export interface Progress {
  readonly done: number;
  readonly total: number;
  readonly task: LoadTask | null;
  readonly status: LoadStatus;
  readonly error?: unknown;
}

/** Flattens the manifest into tasks; each task stores its own (validated) result. */
function tasksFromManifest(
  manifest: Manifest,
  audioCtx: AudioContext | null,
  result: LoadedAssets,
): LoadTask[] {
  const tasks: LoadTask[] = [];
  const task = (
    group: LoadTask['group'],
    key: string,
    entry: ManifestEntry,
    load: LoadTask['load'],
  ) => tasks.push({ group, key, url: entry.url, critical: entry.critical ?? false, load });

  const atlas = manifest.atlas;
  if (atlas)
    task(
      'atlas',
      'atlas',
      atlas,
      async (signal) => void (result.atlas = await loadJson(atlas.url, AtlasSchema, { signal })),
    );
  for (const [key, e] of Object.entries(manifest.images))
    task(
      'images',
      key,
      e,
      async (signal) => void (result.images[key] = await loadImage(e.url, { signal })),
    );
  for (const [key, e] of Object.entries(manifest.sounds))
    task(
      'sounds',
      key,
      e,
      async (signal) => void (result.sounds[key] = await loadAudio(audioCtx, e.url, { signal })),
    );
  for (const [key, e] of Object.entries(manifest.arenas))
    task(
      'arenas',
      key,
      e,
      async (signal) => void (result.arenas[key] = await loadJson(e.url, ArenaSchema, { signal })),
    );
  return tasks;
}

export interface LoadOptions {
  audioCtx?: AudioContext | null;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal | undefined;
  sequential?: boolean;
  log?: Pick<Console, 'info' | 'warn'>;
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
  manifest: Manifest,
  { audioCtx = null, onProgress, signal, sequential = false, log = console }: LoadOptions = {},
): Promise<LoadedAssets> {
  const result: LoadedAssets = {
    atlas: null,
    images: {},
    sounds: {},
    arenas: {},
    failures: [],
    retries: 0,
    ms: 0,
  };
  const tasks = tasksFromManifest(manifest, audioCtx, result);
  const total = tasks.length;
  let done = 0;
  const limit = createLimiter(MAX_PARALLEL);
  const started = performance.now();
  onProgress?.({ done, total, task: null, status: 'start' });

  async function run(task: LoadTask): Promise<void> {
    try {
      await withRetry(() => limit(() => task.load(signal)), {
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
      done++;
      onProgress?.({ done, total, task, status: 'ok' });
    } catch (error: unknown) {
      // Abort and critical failures propagate and reject Promise.all.
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (aborted || task.critical) throw error;
      result.failures.push({ ...task, error, reason: describeError(error) });
      log.warn(
        `[assets] FAILED ${shortUrl(task.url)}: ${describeError(error)} — continuing with fallback`,
      );
      done++;
      onProgress?.({ done, total, task, status: 'failed', error });
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
