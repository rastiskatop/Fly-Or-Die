// Network helpers shared by the asset loader and the lobby.

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Combines the caller's signal (user abort) with a per-request timeout signal. */
function withTimeout(signal, timeoutMs) {
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/**
 * fetch() that treats HTTP errors as errors.
 * fetch itself only rejects on network failure; a 404 is a *fulfilled* promise with ok === false.
 * The timeout covers the headers AND the body read that the caller does next.
 */
export async function fetchChecked(url, { signal, timeoutMs } = {}) {
  const res = await fetch(url, { signal: withTimeout(signal, timeoutMs) });
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}

export async function fetchJson(url, options) {
  const res = await fetchChecked(url, options);
  // Second async step: the body. A corrupt file rejects here with SyntaxError.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    const bad = new SyntaxError(`Invalid JSON in ${url}: ${err.message}`);
    bad.url = url;
    throw bad;
  }
}

/** Promise-based, abortable setTimeout. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(id);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Transient = worth retrying: network failure (TypeError), timeout, 5xx, 408, 429.
 * Never retry: user abort, other 4xx (the file is not there — asking again won't help), bad JSON.
 */
export function isTransient(err) {
  if (err?.name === 'AbortError') return false;
  if (err?.name === 'TimeoutError') return true;
  if (err instanceof HttpError)
    return err.status >= 500 || err.status === 408 || err.status === 429;
  return err instanceof TypeError; // fetch network failure
}

/**
 * Retries fn with exponential backoff + jitter.
 * delay = min(maxMs, baseMs * 2^(attempt-1)), then "equal jitter": half fixed, half random,
 * so many clients that failed together don't all retry at the same instant.
 */
export async function withRetry(
  fn,
  { attempts = 3, baseMs = 250, maxMs = 3000, signal, onRetry } = {},
) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !isTransient(err) || signal?.aborted) throw err;
      const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(cap / 2 + Math.random() * (cap / 2));
      onRetry?.({ attempt, delay, error: err });
      await sleep(delay, signal);
    }
  }
}

/** Short human description of an error for the UI. */
export function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return 'cancelled';
  if (err.name === 'TimeoutError') return 'timed out';
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  if (err instanceof SyntaxError) return 'corrupt JSON';
  if (err instanceof TypeError) return 'network error';
  if (err.name === 'EncodingError') return 'cannot decode';
  return err.message || String(err);
}

/**
 * Runs at most `max` async jobs at once; the rest wait in a FIFO queue.
 * Why: browsers open only ~6 HTTP/1.1 connections per host. With Promise.all over 12 fetches,
 * requests 7–12 sit in the browser's queue while their AbortSignal.timeout is already ticking,
 * so on a slow network they "time out" without ever being sent (found in the failure gallery).
 * Queuing them here means the timeout starts when the request really starts.
 */
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
