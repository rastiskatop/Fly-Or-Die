import { Bus, type AbortSignalLike } from '@flyordie/shared/bus.ts';
import {
  CLOSE,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type OutgoingClientMessage,
  type ServerEvents,
} from '@flyordie/shared/net/messages.ts';

export type ConnState = 'idle' | 'connecting' | 'reconnecting' | 'open' | 'waiting' | 'closed';

export interface StatusInfo {
  readonly state: ConnState;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly code?: number;
  readonly reason?: string;
}

/** Everything a Connection announces: every server message type, plus transport events. */
export type ConnectionEvents = ServerEvents & {
  status: StatusInfo;
  open: undefined;
  close: { readonly code: number; readonly reason: string };
  binary: ArrayBuffer;
};

const NO_RETRY: ReadonlySet<number> = new Set([
  CLOSE.POLICY,
  CLOSE.TOO_BIG,
  CLOSE.BAD_MESSAGE,
  CLOSE.UNKNOWN_TYPE,
  CLOSE.BAD_VERSION,
  CLOSE.JOIN_TIMEOUT,
  CLOSE.JOIN_REFUSED,
  CLOSE.SLOW_CLIENT,
]);
const MAX_QUEUE = 50;

/**
 * WebSocket wrapper.
 *  - every text frame is validated with ServerMessageSchema and dispatched on a typed Bus by `type`:
 *    conn.on('roster', m => m.players) — m is the roster message, checked at runtime and compile time
 *  - send queue: messages sent while (re)connecting are flushed once the app calls markReady()
 *  - reconnect with exponential backoff + jitter when the connection drops unexpectedly
 *  - no reconnect after close(), or when the server refused us on purpose
 */
export class Connection {
  #ws: WebSocket | null = null;
  readonly #queue: OutgoingClientMessage[] = [];
  readonly #bus = new Bus<ConnectionEvents>();
  #ready = false;
  #wanted = false; // false after close(): don't reconnect
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  readonly url: string;
  readonly baseMs: number;
  readonly maxMs: number;
  state: ConnState = 'idle';
  bytesIn = 0;
  bytesOut = 0;
  /** Our player id, from the last 'welcome'. */
  selfId: string | null = null;

  constructor(
    url: string,
    { baseMs = 500, maxMs = 8000 }: { baseMs?: number; maxMs?: number } = {},
  ) {
    this.url = url;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }

  on<K extends keyof ConnectionEvents>(
    type: K,
    fn: (payload: ConnectionEvents[K]) => void,
    options: { signal?: AbortSignalLike } = {},
  ): () => void {
    return this.#bus.on(type, fn, options);
  }

  #setState(state: ConnState, extra: Omit<StatusInfo, 'state'> = {}): void {
    this.state = state;
    this.#bus.emit('status', { state, ...extra });
  }

  connect(): void {
    this.#wanted = true;
    clearTimeout(this.#timer);
    this.#ready = false;
    this.#setState(this.#attempt ? 'reconnecting' : 'connecting', { attempt: this.#attempt });

    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer'; // binary frames (Lab 5 snapshots) arrive as ArrayBuffer, not Blob
    this.#ws = ws;
    ws.addEventListener('open', () => {
      this.#attempt = 0;
      this.#setState('open');
      this.#bus.emit('open', undefined);
    });
    ws.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (e.data instanceof ArrayBuffer) {
        this.bytesIn += e.data.byteLength;
        this.#bus.emit('binary', e.data);
        return;
      }
      if (typeof e.data !== 'string') return;
      this.bytesIn += e.data.length; // ≈ bytes (control messages are ASCII-ish)
      this.#dispatch(e.data);
    });
    // 'error' on a WebSocket carries no details; 'close' always follows and has the code.
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', (e) => {
      if (this.#ws !== ws) return; // an old socket we already replaced
      this.#ready = false;
      this.#bus.emit('close', { code: e.code, reason: e.reason });
      if (!this.#wanted || NO_RETRY.has(e.code)) {
        this.#setState('closed', { code: e.code, reason: e.reason });
        return;
      }
      this.#scheduleReconnect(e.code);
    });
  }

  /** Untrusted text → validated message → the listeners of its type. */
  #dispatch(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      console.warn('[net] ignoring non-JSON message');
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn('[net] ignoring invalid server message', parsed.error.issues[0]);
      return;
    }
    const msg = parsed.data;
    if (msg.type === 'welcome') this.selfId = msg.playerId;
    // One case per type: the compiler pairs each `type` with its payload (and the never-check
    // fails the build if a new server message type isn't handled).
    switch (msg.type) {
      case 'welcome':
        return this.#bus.emit('welcome', msg);
      case 'roster':
        return this.#bus.emit('roster', msg);
      case 'chat':
        return this.#bus.emit('chat', msg);
      case 'system':
        return this.#bus.emit('system', msg);
      case 'error':
        return this.#bus.emit('error', msg);
      case 'pong':
        return this.#bus.emit('pong', msg);
      case 'snapshot':
        return this.#bus.emit('snapshot', msg);
      default: {
        const unreachable: never = msg;
        return unreachable;
      }
    }
  }

  #scheduleReconnect(code: number): void {
    this.#attempt++;
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** (this.#attempt - 1));
    const delayMs = Math.round(cap / 2 + Math.random() * (cap / 2));
    this.#setState('waiting', { attempt: this.#attempt, delayMs, code });
    this.#timer = setTimeout(() => this.connect(), delayMs);
  }

  /** Sends immediately; only valid while open (used for the join handshake). */
  sendNow(msg: OutgoingClientMessage): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
    this.#ws.send(text);
    this.bytesOut += text.length;
    return true;
  }

  /** Hot path (inputs): an already-encoded frame — binary (Uint8Array) or JSON text. Never queued. */
  sendRaw(data: string | Uint8Array<ArrayBuffer>): boolean {
    if (!this.#ready || this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(data);
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    return true;
  }

  /** Sends now if ready, otherwise queues (bounded) until markReady(). */
  send(msg: OutgoingClientMessage): boolean {
    if (this.#ready && this.sendNow(msg)) return true;
    if (this.#queue.length >= MAX_QUEUE) this.#queue.shift(); // drop the oldest
    this.#queue.push(msg);
    return false;
  }

  /** The server accepted our join: flush everything queued while we were away. */
  markReady(): void {
    this.#ready = true;
    while (this.#queue.length) {
      const next = this.#queue[0];
      if (!next || !this.sendNow(next)) break;
      this.#queue.shift();
    }
  }

  get queued(): number {
    return this.#queue.length;
  }

  close(code: number = CLOSE.NORMAL, reason = 'bye'): void {
    this.#wanted = false;
    clearTimeout(this.#timer);
    this.#queue.length = 0;
    this.#ws?.close(code, reason);
    this.#setState('closed', { code });
  }
}
