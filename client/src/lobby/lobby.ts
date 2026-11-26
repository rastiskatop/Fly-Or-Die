import { z } from 'zod';
import { shortUrl } from '../assets/base.ts';
import { fetchJson, withRetry, sleep, describeError } from '../assets/net.ts';
import { Bus, type AbortSignalLike } from '@flyordie/shared/bus.ts';
import {
  RoomInfoSchema,
  RoomsResponseSchema,
  type RoomInfo,
} from '@flyordie/shared/net/messages.ts';

export interface LobbyEvents {
  loading: undefined;
  rooms: { readonly rooms: readonly RoomInfo[] };
  error: { readonly error: unknown; readonly message: string };
  join: { readonly room: RoomInfo; readonly name: string };
}

const CreatedSchema = z.object({ room: RoomInfoSchema });
const ErrorBodySchema = z.object({ error: z.string() });

/**
 * Lobby data layer. Knows nothing about the DOM — it fetches rooms and announces, on a typed Bus:
 *   loading · rooms {rooms} · error {error, message} · join {room, name}
 * Online (a game server was found): GET/POST {apiBase}/api/rooms. Offline: the static rooms list.
 * Every response is validated with the shared zod schema before anyone sees it.
 */
export class Lobby {
  #rooms: readonly RoomInfo[] = [];
  #poll: AbortController | null = null; // the running poll loop
  #requests = 0;
  #aborted = 0;
  readonly #bus = new Bus<LobbyEvents>();

  readonly url: string;
  /** null = offline, rooms can't be created */
  readonly createUrl: string | null;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  lastUpdated: number | null = null;

  constructor({
    url,
    createUrl = null,
    intervalMs = 3000,
    timeoutMs = 2500,
  }: {
    url: string;
    createUrl?: string | null;
    intervalMs?: number;
    timeoutMs?: number;
  }) {
    this.url = url;
    this.createUrl = createUrl;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
  }

  on<K extends keyof LobbyEvents>(
    type: K,
    fn: (payload: LobbyEvents[K]) => void,
    options: { signal?: AbortSignalLike } = {},
  ): () => void {
    return this.#bus.on(type, fn, options);
  }

  get online(): boolean {
    return this.createUrl !== null;
  }

  /** POST /api/rooms. Resolves with the new room; rejects with the server's error message. */
  async createRoom({ name, arena }: { name: string; arena: string }): Promise<RoomInfo> {
    if (!this.createUrl) throw new Error('offline: start the server to create rooms');
    const res = await fetch(this.createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arena }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = ErrorBodySchema.safeParse(body);
      throw new Error(err.success ? err.data.error : `HTTP ${res.status}`);
    }
    await this.refreshNow();
    return CreatedSchema.parse(body).room;
  }

  get rooms(): readonly RoomInfo[] {
    return this.#rooms;
  }

  get polling(): boolean {
    return this.#poll !== null;
  }

  get stats(): { requests: number; aborted: number } {
    return { requests: this.#requests, aborted: this.#aborted };
  }

  /** One refresh. Every attempt has its own timeout (AbortSignal.timeout inside fetchJson). */
  async refresh(signal?: AbortSignal): Promise<void> {
    this.#bus.emit('loading', undefined);
    try {
      const data = await withRetry(
        async () => {
          this.#requests++;
          return RoomsResponseSchema.parse(
            await fetchJson(this.url, { signal, timeoutMs: this.timeoutMs }),
          );
        },
        { attempts: 2, baseMs: 300, signal },
      );
      this.#rooms = data.rooms;
      this.lastUpdated = Date.now();
      this.#bus.emit('rooms', { rooms: this.#rooms });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // We left the lobby while this request was in flight — expected, not an error.
        this.#aborted++;
        console.info(`[lobby] in-flight request to ${shortUrl(this.url)} aborted (left the lobby)`);
        return;
      }
      this.#bus.emit('error', { error, message: describeError(error) });
    }
  }

  /** Manual refresh button: uses the poll's signal so leaving the lobby aborts it too. */
  refreshNow(): Promise<void> {
    return this.refresh(this.#poll?.signal);
  }

  /** Starts refreshing every intervalMs until stop(). An async loop, not setInterval:
   *  the next request never starts before the previous one finished. */
  start(): void {
    if (this.#poll) return;
    const controller = new AbortController();
    this.#poll = controller;
    const { signal } = controller;
    void (async () => {
      while (!signal.aborted) {
        await this.refresh(signal);
        await sleep(this.intervalMs, signal).catch(() => {}); // abort ends the wait early
      }
    })();
  }

  /** Leaving the lobby: aborts the loop AND any request in flight. No orphaned fetches. */
  stop(): void {
    this.#poll?.abort();
    this.#poll = null;
  }

  join(roomId: string, name: string): void {
    const room = this.#rooms.find((r) => r.id === roomId);
    const trimmed = name.trim();
    if (!room) throw new Error(`room ${roomId} not found`);
    if (!trimmed) throw new Error('enter a pilot name');
    if (room.players >= room.maxPlayers) throw new Error(`${room.name} is full`);
    this.stop();
    this.#bus.emit('join', { room, name: trimmed.slice(0, 16) });
  }

  /** Promise for the next "join" event (promise ⇐ event). */
  nextJoin(): Promise<LobbyEvents['join']> {
    return new Promise((resolve) => {
      const off = this.#bus.on('join', (payload) => {
        off();
        resolve(payload);
      });
    });
  }
}
