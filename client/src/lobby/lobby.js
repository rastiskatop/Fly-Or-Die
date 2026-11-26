import { shortUrl } from '../assets/base.js';
import { fetchJson, withRetry, sleep, describeError } from '../assets/net.js';

/**
 * Lobby data layer. Knows nothing about the DOM — it fetches rooms and dispatches events:
 *   "loading"            a refresh started
 *   "rooms"   {rooms}    fresh list arrived
 *   "error"   {error, message}  a refresh failed (timeout, HTTP, bad JSON...)
 *   "join"    {room, name}      the player joined a room (polling already stopped)
 * Online (a game server was found): GET/POST {apiBase}/api/rooms. Offline: the static rooms.json.
 */
export class Lobby extends EventTarget {
  #rooms = [];
  #poll = null; // AbortController of the running poll loop
  #requests = 0;
  #aborted = 0;

  constructor({ url, createUrl = null, intervalMs = 3000, timeoutMs = 2500 }) {
    super();
    this.url = url;
    this.createUrl = createUrl; // null = offline, rooms can't be created
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.lastUpdated = null;
  }

  get online() {
    return this.createUrl !== null;
  }

  /** POST /api/rooms. Resolves with the new room; rejects with the server's error message. */
  async createRoom({ name, arena }) {
    if (!this.createUrl) throw new Error('offline: start the server to create rooms');
    const res = await fetch(this.createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arena }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    await this.refreshNow();
    return data.room;
  }

  get rooms() {
    return this.#rooms;
  }

  get polling() {
    return this.#poll !== null;
  }

  get stats() {
    return { requests: this.#requests, aborted: this.#aborted };
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** One refresh. Every attempt has its own timeout (AbortSignal.timeout inside fetchJson). */
  async refresh(signal) {
    this.#emit('loading');
    try {
      const data = await withRetry(
        () => {
          this.#requests++;
          return fetchJson(this.url, { signal, timeoutMs: this.timeoutMs });
        },
        { attempts: 2, baseMs: 300, signal },
      );
      if (!Array.isArray(data?.rooms)) throw new TypeError('rooms response has no "rooms" array');
      this.#rooms = data.rooms;
      this.lastUpdated = Date.now();
      this.#emit('rooms', { rooms: this.#rooms });
    } catch (error) {
      if (error?.name === 'AbortError') {
        // We left the lobby while this request was in flight — expected, not an error.
        this.#aborted++;
        console.info(`[lobby] in-flight request to ${shortUrl(this.url)} aborted (left the lobby)`);
        return;
      }
      this.#emit('error', { error, message: describeError(error) });
    }
  }

  /** Manual refresh button: uses the poll's signal so leaving the lobby aborts it too. */
  refreshNow() {
    return this.refresh(this.#poll?.signal);
  }

  /** Starts refreshing every intervalMs until stop(). An async loop, not setInterval:
   *  the next request never starts before the previous one finished. */
  start() {
    if (this.#poll) return;
    const controller = new AbortController();
    this.#poll = controller;
    const { signal } = controller;
    (async () => {
      while (!signal.aborted) {
        await this.refresh(signal);
        await sleep(this.intervalMs, signal).catch(() => {}); // abort ends the wait early
      }
    })();
  }

  /** Leaving the lobby: aborts the loop AND any request in flight. No orphaned fetches. */
  stop() {
    this.#poll?.abort();
    this.#poll = null;
  }

  join(roomId, name) {
    const room = this.#rooms.find((r) => r.id === roomId);
    const trimmed = name.trim();
    if (!room) throw new Error(`room ${roomId} not found`);
    if (!trimmed) throw new Error('enter a pilot name');
    if (room.players >= room.maxPlayers) throw new Error(`${room.name} is full`);
    this.stop();
    this.#emit('join', { room, name: trimmed.slice(0, 16) });
  }

  /** Promise for the next "join" event (promise ⇐ event, { once: true }). */
  nextJoin() {
    return new Promise((resolve) =>
      this.addEventListener('join', (e) => resolve(e.detail), { once: true }),
    );
  }
}
