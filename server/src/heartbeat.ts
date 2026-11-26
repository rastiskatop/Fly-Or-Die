// Dead TCP connections never send a close frame. Ping every interval; a socket that misses
// `maxMissed` pongs in a row is terminated. The pong handler (in ws.ts) resets missedPongs to 0.
// A standalone function over a tiny interface, so it can be tested with fake timers and fakes.
export interface Pingable {
  ping(): void;
  terminate(): void;
}

export interface HeartbeatOptions<S extends Pingable> {
  readonly intervalMs: number;
  readonly maxMissed?: number;
  /** The sockets to check on every beat (read fresh each time). */
  readonly sockets: () => Iterable<S>;
  /** Per-socket counter; undefined = not tracked (skipped). */
  readonly stateOf: (socket: S) => { missedPongs: number } | undefined;
  readonly onDead?: (socket: S) => void;
}

/** Starts the heartbeat; returns a stop function. The timer never keeps the process alive. */
export function startHeartbeat<S extends Pingable>({
  intervalMs,
  maxMissed = 2,
  sockets,
  stateOf,
  onDead,
}: HeartbeatOptions<S>): () => void {
  const timer = setInterval(() => {
    for (const socket of sockets()) {
      const state = stateOf(socket);
      if (!state) continue;
      if (state.missedPongs >= maxMissed) {
        onDead?.(socket);
        socket.terminate();
        continue;
      }
      state.missedPongs++;
      socket.ping();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
