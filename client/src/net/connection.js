/**
 * WebSocket wrapper.
 *  - dispatches every server message as a CustomEvent named after its `type`
 *    (conn.addEventListener('roster', e => e.detail.players))
 *  - send queue: messages sent while (re)connecting are kept and flushed once the app calls
 *    markReady() (after the server accepted our join), in order
 *  - reconnect with exponential backoff + jitter when the connection drops unexpectedly
 *  - no reconnect after close(), or when the server refused us on purpose (4000–4005, 1008, 1009)
 * Events: 'status' { state, attempt?, delayMs?, code? }, 'open', 'close' { code, reason }, '<type>'
 */
const NO_RETRY = new Set([1008, 1009, 4000, 4001, 4002, 4003, 4004, 4005]);
const MAX_QUEUE = 50;

export class Connection extends EventTarget {
  #ws = null;
  #queue = [];
  #ready = false;
  #wanted = false; // false after close(): don't reconnect
  #attempt = 0;
  #timer = null;

  constructor(url, { baseMs = 500, maxMs = 8000 } = {}) {
    super();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.url = url;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.state = 'idle';
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.#emit('status', { state, ...extra });
  }

  connect() {
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
      this.#emit('open');
    });
    ws.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.bytesIn += e.data.byteLength;
        this.#emit('binary', e.data);
        return;
      }
      this.bytesIn += e.data.length; // ≈ bytes (control messages are ASCII-ish)
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return console.warn('[net] ignoring non-JSON message');
      }
      if (typeof msg?.type === 'string') this.#emit(msg.type, msg);
    });
    // 'error' on a WebSocket carries no details; 'close' always follows and has the code.
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', (e) => {
      if (this.#ws !== ws) return; // an old socket we already replaced
      this.#ready = false;
      this.#emit('close', { code: e.code, reason: e.reason });
      if (!this.#wanted || NO_RETRY.has(e.code)) {
        this.#setState('closed', { code: e.code, reason: e.reason });
        return;
      }
      this.#scheduleReconnect(e.code);
    });
  }

  #scheduleReconnect(code) {
    this.#attempt++;
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** (this.#attempt - 1));
    const delayMs = Math.round(cap / 2 + Math.random() * (cap / 2));
    this.#setState('waiting', { attempt: this.#attempt, delayMs, code });
    this.#timer = setTimeout(() => this.connect(), delayMs);
  }

  /** Sends immediately; only valid while open (used for the join handshake). */
  sendNow(msg) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify({ v: 1, ...msg });
    this.#ws.send(text);
    this.bytesOut += text.length;
    return true;
  }

  /** Hot path (Lab 5 inputs): an already-encoded frame — binary (Uint8Array) or JSON text. Never queued. */
  sendRaw(data) {
    if (!this.#ready || this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(data);
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    return true;
  }

  /** Sends now if ready, otherwise queues (bounded) until markReady(). */
  send(msg) {
    if (this.#ready && this.sendNow(msg)) return true;
    if (this.#queue.length >= MAX_QUEUE) this.#queue.shift(); // drop the oldest
    this.#queue.push(msg);
    return false;
  }

  /** The server accepted our join: flush everything queued while we were away. */
  markReady() {
    this.#ready = true;
    while (this.#queue.length && this.sendNow(this.#queue[0])) this.#queue.shift();
  }

  get queued() {
    return this.#queue.length;
  }

  close(code = 1000, reason = 'bye') {
    this.#wanted = false;
    clearTimeout(this.#timer);
    this.#queue.length = 0;
    this.#ws?.close(code, reason);
    this.#setState('closed', { code });
  }
}
