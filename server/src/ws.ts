import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, type RawData, type WebSocketServer } from 'ws';
import { parseFrame, serverMessage, CLOSE } from './protocol.ts';
import { TokenBucket } from './rate-limit.ts';
import { log } from './logger.ts';
import { TICK_RATE } from '@flyordie/shared/net/protocol.ts';
import { binaryCodec, jsonCodec } from '@flyordie/shared/net/codec.ts';
import { asSeq, asTick } from '@flyordie/shared/ids.ts';
import type { CloseCode, CodecName, OutgoingServerMessage } from '@flyordie/shared/net/messages.ts';
import type { ServerConfig } from './config.ts';
import type { Room, RoomManager, Player } from './rooms.ts';
import type { Match, TickSnapshot } from './match.ts';

interface NetSim {
  lagMs: number;
  jitterMs: number;
  dropPct: number;
}

/** Everything we know about one connection. Kept in a WeakMap — no untyped props on WebSocket. */
interface ConnState {
  readonly id: string;
  readonly ip: string;
  player: Player | null;
  roomId: string | null;
  codec: CodecName;
  netsim: NetSim;
  outAt: number;
  inAt: number;
  bytesIn: number;
  bytesOut: number;
  readonly connectedAt: number;
  missedPongs: number;
  dropped: number;
  readonly bucket: TokenBucket;
  readonly inputBucket: TokenBucket;
}

export interface ServerStats {
  connections: number;
  dropped: number;
  bytesIn: number;
  bytesOut: number;
}

interface SendOptions {
  critical?: boolean;
  unreliable?: boolean;
}

/** ws hands us Buffer | ArrayBuffer | Buffer[] depending on settings — normalize once. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Connection lifecycle for every WebSocket:
 *
 *   connect ──(join within JOIN_TIMEOUT_MS)──▶ in room ──(leave / close / error)──▶ gone
 *      │                                          │
 *      └─ no join in time → close 4003            ├─ every frame: [netsim delay/drop] → parse+validate
 *                                                 │   (zod / binary decoder) → rate limit → dispatch
 *                                                 ├─ 30 Hz: snapshot (binary or JSON) with this client's ack
 *                                                 └─ heartbeat: ping every HEARTBEAT_MS, 2 missed pongs → terminate
 */
export function attachWebSockets(
  wss: WebSocketServer,
  {
    rooms,
    matches,
    config,
    stats,
  }: {
    rooms: RoomManager;
    matches: ReadonlyMap<string, Match>;
    config: ServerConfig;
    stats: ServerStats;
  },
) {
  const states = new WeakMap<WebSocket, ConnState>();
  const socketsByRoom = new Map<string, Set<WebSocket>>();

  function roomSockets(roomId: string): Set<WebSocket> {
    let set = socketsByRoom.get(roomId);
    if (!set) socketsByRoom.set(roomId, (set = new Set()));
    return set;
  }

  // ---------- latency injector (Lab 5) ----------
  function netDelay(state: ConnState, dir: 'outAt' | 'inAt'): number {
    const { lagMs, jitterMs } = state.netsim;
    if (!lagMs && !jitterMs) return 0;
    const now = performance.now();
    // TCP never reorders: never schedule before the previous message in the same direction.
    const at = Math.max(state[dir], now + lagMs / 2 + Math.random() * jitterMs);
    state[dir] = at;
    return at - now;
  }
  const dropped = (state: ConnState) =>
    state.netsim.dropPct > 0 && Math.random() * 100 < state.netsim.dropPct;

  /**
   * Slow-client policy (Lab 4): bufferedAmount over the threshold → drop non-critical messages;
   * over 4× → close. Critical (welcome, roster, error, pong) always go.
   */
  function send(
    socket: WebSocket,
    data: string | Uint8Array,
    { critical = false, unreliable = false }: SendOptions = {},
  ): boolean {
    const state = states.get(socket);
    if (!state || socket.readyState !== WebSocket.OPEN) return false;
    const queued = socket.bufferedAmount;
    if (queued > config.slowClientBytes * 4) {
      log.warn('slow client terminated', { id: state.id, buffered: queued });
      socket.close(CLOSE.SLOW_CLIENT, 'too slow');
      setTimeout(() => socket.terminate(), 1000).unref();
      return false;
    }
    if (!critical && queued > config.slowClientBytes) {
      state.dropped++;
      stats.dropped++;
      return false;
    }
    if (unreliable && dropped(state)) return false;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    const deliver = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(data);
      state.bytesOut += bytes;
      stats.bytesOut += bytes;
    };
    const delay = netDelay(state, 'outAt');
    if (delay > 0) setTimeout(deliver, delay);
    else deliver();
    return true;
  }

  /** Every server → client control message goes through here: shape checked by the compiler. */
  function sendMessage(socket: WebSocket, msg: OutgoingServerMessage, opts?: SendOptions): boolean {
    return send(socket, serverMessage(msg), opts);
  }

  function broadcast(roomId: string, data: string, opts?: SendOptions): void {
    for (const s of socketsByRoom.get(roomId) ?? []) send(s, data, opts);
  }

  // ---------- room events → broadcasts ----------
  function wireRoom(room: Room): void {
    const sendRoster = () =>
      broadcast(room.id, serverMessage({ type: 'roster', players: room.roster() }), {
        critical: true,
      });
    const system = (text: string) =>
      broadcast(room.id, serverMessage({ type: 'system', text, t: Date.now() }));
    room.on('join', (player) => {
      sendRoster();
      system(`${player.name} joined`);
    });
    room.on('leave', (player, reason) => {
      sendRoster();
      system(`${player.name} left (${reason})`);
    });
    room.on('chat', (player, text) => {
      broadcast(
        room.id,
        serverMessage({
          type: 'chat',
          from: { id: player.id, name: player.name },
          text,
          t: Date.now(),
        }),
      );
    });
  }
  rooms.on('roomCreated', wireRoom);
  rooms.on('roomDeleted', (room) => socketsByRoom.delete(room.id));

  // ---------- match snapshots → every client in the room, in its codec, with its own ack ----------
  function wireMatch(match: Match): void {
    match.on('snapshot', (snap: TickSnapshot) => {
      const sockets = socketsByRoom.get(match.roomId);
      if (!sockets?.size) return;
      let binary: Uint8Array | null = null; // encode once, then patch the 4-byte ack (offset 6) per client
      for (const socket of sockets) {
        const state = states.get(socket);
        if (!state) continue;
        const ack = match.ackFor(state.id);
        let data: string | Uint8Array;
        if (state.codec === 'binary') {
          binary ??= binaryCodec.encodeSnapshot({ ...snap, ack: asSeq(0) });
          const copy = binary.slice();
          new DataView(copy.buffer).setUint32(6, ack, true);
          data = copy;
        } else {
          data = jsonCodec.encodeSnapshot({ ...snap, ack });
        }
        send(socket, data, { unreliable: true });
      }
    });
  }

  // ---------- connections ----------
  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const state: ConnState = {
      id: randomUUID().slice(0, 8),
      ip: req.socket.remoteAddress ?? '?',
      player: null,
      roomId: null,
      codec: 'json',
      netsim: { lagMs: 0, jitterMs: 0, dropPct: 0 },
      outAt: 0,
      inAt: 0,
      bytesIn: 0,
      bytesOut: 0,
      connectedAt: Date.now(),
      missedPongs: 0,
      dropped: 0,
      bucket: new TokenBucket({ ratePerSec: config.rateLimitPerSec, burst: config.rateLimitBurst }),
      // Inputs come 30/s by design: their own, larger bucket.
      inputBucket: new TokenBucket({ ratePerSec: TICK_RATE * 2, burst: TICK_RATE * 3 }),
    };
    states.set(socket, state);
    stats.connections++;
    log.info('ws connected', { id: state.id, ip: state.ip });

    // ALWAYS: an 'error' without a listener would throw and take the whole server down.
    socket.on('error', (err) => log.warn('ws error', { id: state.id, err: err.message }));

    const reject = (code: CloseCode, message: string) => {
      log.warn('ws rejected', { id: state.id, code, reason: message });
      if (socket.readyState === WebSocket.OPEN)
        socket.send(serverMessage({ type: 'error', code, message }));
      socket.close(code, message.slice(0, 120)); // close reason is limited to 123 bytes
    };

    const joinTimer = setTimeout(() => {
      if (!state.player) reject(CLOSE.JOIN_TIMEOUT, `no join within ${config.joinTimeoutMs} ms`);
    }, config.joinTimeoutMs);

    socket.on('pong', () => {
      state.missedPongs = 0;
    });

    function handle(data: Buffer, isBinary: boolean): void {
      if (socket.readyState !== WebSocket.OPEN) return;
      const parsed = parseFrame(data, isBinary);
      if (!parsed.ok) return reject(parsed.error.code, parsed.error.reason);
      const msg = parsed.value;
      const bucket = msg.type === 'inputs' ? state.inputBucket : state.bucket;
      if (!bucket.take()) return reject(CLOSE.POLICY, 'rate limit exceeded');

      if (!state.player) {
        if (msg.type !== 'join') return reject(CLOSE.BAD_MESSAGE, 'first message must be join');
        const room = rooms.get(msg.room);
        if (!room) return reject(CLOSE.JOIN_REFUSED, `room ${msg.room} not found`);
        if (room.full) return reject(CLOSE.JOIN_REFUSED, `room ${room.name} is full`);
        clearTimeout(joinTimer);
        state.player = { id: state.id, name: msg.name, joinedAt: Date.now() };
        state.roomId = room.id;
        state.codec = msg.codec;
        roomSockets(room.id).add(socket);
        sendMessage(
          socket,
          { type: 'welcome', playerId: state.id, room: room.toJSON(), tickRate: TICK_RATE },
          { critical: true },
        );
        room.join(state.player); // → match spawns our ship → roster (with shipId) to everyone
        log.info('player joined', {
          id: state.id,
          name: msg.name,
          room: room.id,
          codec: state.codec,
        });
        return;
      }

      const roomId = state.roomId;
      const room = roomId === null ? undefined : rooms.get(roomId);
      const match = roomId === null ? undefined : matches.get(roomId);
      switch (msg.type) {
        case 'inputs':
          match?.pushInputs(state.id, msg.inputs);
          break;
        case 'ping':
          sendMessage(
            socket,
            { type: 'pong', t: msg.t, tick: asTick(match?.world.tick ?? 0) },
            { critical: true },
          );
          break;
        case 'netsim':
          state.netsim = { lagMs: msg.lagMs, jitterMs: msg.jitterMs, dropPct: msg.dropPct };
          log.info('netsim', { id: state.id, ...state.netsim });
          break;
        case 'chat':
          room?.chat(state.id, msg.text);
          break;
        case 'leave':
          socket.close(CLOSE.NORMAL, 'bye');
          break;
        case 'join':
          reject(CLOSE.BAD_MESSAGE, 'already joined');
          break;
        default: {
          const unreachable: never = msg; // a new client message type must be handled here
          return unreachable;
        }
      }
    }

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      const data = toBuffer(raw);
      state.bytesIn += data.length;
      stats.bytesIn += data.length;
      const isInput = isBinary || (data.length < 600 && data.includes('"inputs"'));
      if (isInput && dropped(state)) return; // simulated packet loss (inputs only)
      const delay = netDelay(state, 'inAt');
      if (delay > 0) setTimeout(() => handle(data, isBinary), delay);
      else handle(data, isBinary);
    });

    socket.on('close', (code: number) => {
      clearTimeout(joinTimer);
      stats.connections--;
      if (state.roomId) {
        socketsByRoom.get(state.roomId)?.delete(socket);
        rooms
          .get(state.roomId)
          ?.leave(state.id, code === CLOSE.NORMAL ? 'left' : `disconnected ${code}`);
      }
      log.info('ws closed', { id: state.id, code, dropped: state.dropped });
    });
  });

  // ---------- heartbeat ----------
  // Dead TCP connections never send a close frame. Ping/pong finds them; 2 missed pongs → terminate.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (!state) continue;
      if (state.missedPongs >= 2) {
        log.warn('heartbeat: terminating dead socket', { id: state.id });
        socket.terminate();
        continue;
      }
      state.missedPongs++;
      socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    wireMatch,

    connectionStats() {
      return [...wss.clients].flatMap((s) => {
        const st = states.get(s);
        if (!st) return [];
        const secs = Math.max(1, (Date.now() - st.connectedAt) / 1000);
        return [
          {
            id: st.id,
            room: st.roomId,
            codec: st.codec,
            netsim: st.netsim,
            kbInPerS: +(st.bytesIn / 1024 / secs).toFixed(2),
            kbOutPerS: +(st.bytesOut / 1024 / secs).toFixed(2),
            dropped: st.dropped,
          },
        ];
      });
    },

    /** Graceful shutdown: tell every client we're going away (1001). Resolves when all closed. */
    closeAll(): Promise<void[]> {
      clearInterval(heartbeat);
      const closed = [...wss.clients].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.close(CLOSE.GOING_AWAY, 'server shutting down');
          }),
      );
      return Promise.all(closed);
    },
  };
}

export type SocketsApi = ReturnType<typeof attachWebSockets>;
