// Network helpers shared by the asset loader and the lobby.
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** Combines the caller's signal (user abort) with a per-request timeout signal. */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  if (signals.length <= 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * fetch() that treats HTTP errors as errors.
 * fetch itself only rejects on network failure; a 404 is a *fulfilled* promise with ok === false.
 * The timeout covers the headers AND the body read that the caller does next.
 */
export async function fetchChecked(
  url: string,
  { signal, timeoutMs }: RequestOptions = {},
): Promise<Response> {
  const timed = withTimeout(signal, timeoutMs);
  const res = await fetch(url, timed ? { signal: timed } : {});
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}

/**
 * Returns `unknown`, on purpose: JSON from the network is untrusted until a schema says otherwise.
 * (res.json() would return `any` and silently switch type checking off for everything it touches.)
 */
export async function fetchJson(url: string, options?: RequestOptions): Promise<unknown> {
  const res = await fetchChecked(url, options);
  // Second async step: the body. A corrupt file rejects here with SyntaxError.
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text); // JSON.parse is typed `any` — pin it to unknown
    return parsed;
  } catch (err: unknown) {
    throw new SyntaxError(
      `Invalid JSON in ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** `signal.reason` is typed `any` and can be anything abort() was called with: always reject with an Error. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

/** Promise-based, abortable setTimeout. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(id);
      reject(abortReason(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const errorName = (err: unknown): string | undefined =>
  err instanceof Error || err instanceof DOMException ? err.name : undefined;

/**
 * Transient = worth retrying: network failure (TypeError), timeout, 5xx, 408, 429.
 * Never retry: user abort, other 4xx (the file is not there — asking again won't help), bad JSON.
 */
export function isTransient(err: unknown): boolean {
  if (errorName(err) === 'AbortError') return false;
  if (errorName(err) === 'TimeoutError') return true;
  if (err instanceof HttpError)
    return err.status >= 500 || err.status === 408 || err.status === 429;
  return err instanceof TypeError; // fetch network failure
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal | undefined;
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

/**
 * Retries fn with exponential backoff + jitter (generic over what fn resolves to).
 * delay = min(maxMs, baseMs * 2^(attempt-1)), then "equal jitter": half fixed, half random.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  { attempts = 3, baseMs = 250, maxMs = 3000, signal, onRetry }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err: unknown) {
      if (attempt >= attempts || !isTransient(err) || signal?.aborted) throw err;
      const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(cap / 2 + Math.random() * (cap / 2));
      onRetry?.({ attempt, delay, error: err });
      await sleep(delay, signal);
    }
  }
}

/** Short human description of an error for the UI. */
export function describeError(err: unknown): string {
  if (!err) return 'unknown error';
  const name = errorName(err);
  if (name === 'AbortError') return 'cancelled';
  if (name === 'TimeoutError') return 'timed out';
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  if (err instanceof ZodError)
    return `invalid data (${err.issues[0]?.path.join('.') || 'root'}: ${err.issues[0]?.message ?? '?'})`;
  if (err instanceof SyntaxError) return 'corrupt JSON';
  if (err instanceof TypeError) return 'network error';
  if (name === 'EncodingError') return 'cannot decode';
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : 'unknown error'; // String({}) would say "[object Object]"
}

/**
 * Runs at most `max` async jobs at once; the rest wait in a FIFO queue.
 * Why: browsers open only ~6 HTTP/1.1 connections per host — see the Lab 3 failure gallery.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  // Each queued job is a closure that already knows its own resolve/reject — no generic
  // bookkeeping (and no casts) needed to keep T straight.
  const queue: (() => Promise<void>)[] = [];
  const next = (): void => {
    if (active >= max) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    void job().finally(() => {
      active--;
      next();
    });
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => Promise.resolve().then(fn).then(resolve, reject));
      next();
    });
}
