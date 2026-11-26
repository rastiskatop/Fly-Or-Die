import { randomUUID } from 'node:crypto';
import { parseClientMessage, encode, CLOSE } from './protocol.js';
import { TokenBucket } from './rate-limit.js';
import { log } from './logger.js';
import { TICK_RATE } from '@flyordie/shared/net/protocol.js';
import * as binaryCodec from '@flyordie/shared/net/codec-binary.js';
import * as jsonCodec from '@flyordie/shared/net/codec-json.js';

/**
 * Connection lifecycle for every WebSocket:
 *
 *   connect ──(join within JOIN_TIMEOUT_MS)──▶ in room ──(leave / close / error)──▶ gone
 *      │                                          │
 *      └─ no join in time → close 4003            ├─ every message: [netsim delay/drop] → rate limit
 *                                                 │   → validate → dispatch
 *                                                 ├─ 30 Hz: snapshot (binary or JSON) with this client's ack
 *                                                 └─ heartbeat: ping every HEARTBEAT_MS, 2 missed pongs → terminate
 */
export function attachWebSockets(wss, { rooms, matches, config, stats }) {
  const socketsByRoom = new Map(); // roomId -> Set<socket>

  function roomSockets(roomId) {
    let set = socketsByRoom.get(roomId);
    if (!set) socketsByRoom.set(roomId, (set = new Set()));
    return set;
  }

  // ---------- latency injector (Lab 5) ----------
  // Per connection: { lagMs, jitterMs, dropPct } set by the client's 'netsim' message.
  // Each direction gets lag/2 + random jitter. WebSocket is TCP: messages never overtake each other,
  // so a message is never scheduled earlier than the previous one in the same direction.
  // Drops only apply to "unreliable" traffic — snapshots down and inputs up — like UDP would.
  function netDelay(state, dir) {
    const { lagMs, jitterMs } = state.netsim;
    if (!lagMs && !jitterMs) return 0;
    const now = performance.now();
    const at = Math.max(state[dir], now + lagMs / 2 + Math.random() * jitterMs);
    state[dir] = at;
    return at - now;
  }
  const dropped = (state) => state.netsim.dropPct > 0 && Math.random() * 100 < state.netsim.dropPct;

  /**
   * Slow-client policy (Lab 4): bufferedAmount over the threshold → drop non-critical messages
   * (chat, system, snapshots); over 4× → close. Critical (welcome, roster, error, pong) always go.
   */
  function send(socket, data, { critical = false, unreliable = false } = {}) {
    if (socket.readyState !== socket.OPEN) return false;
    const state = socket.state;
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
      if (socket.readyState !== socket.OPEN) return;
      socket.send(data);
      state.bytesOut += bytes;
      stats.bytesOut += bytes;
    };
    const delay = netDelay(state, 'outAt');
    if (delay > 0) setTimeout(deliver, delay);
    else deliver();
    return true;
  }

  function broadcast(roomId, data, opts) {
    for (const s of socketsByRoom.get(roomId) ?? []) send(s, data, opts);
  }

  // ---------- room events → broadcasts ----------
  function wireRoom(room) {
    const sendRoster = () =>
      broadcast(room.id, encode('roster', { players: room.roster() }), { critical: true });
    room.on('join', (player) => {
      sendRoster();
      broadcast(room.id, encode('system', { text: `${player.name} joined`, t: Date.now() }));
    });
    room.on('leave', (player, reason) => {
      sendRoster();
      broadcast(
        room.id,
        encode('system', { text: `${player.name} left (${reason})`, t: Date.now() }),
      );
    });
    room.on('chat', (player, text) => {
      broadcast(
        room.id,
        encode('chat', { from: { id: player.id, name: player.name }, text, t: Date.now() }),
      );
    });
  }
  rooms.on('roomCreated', wireRoom);
  rooms.on('roomDeleted', (room) => socketsByRoom.delete(room.id));

  // ---------- match snapshots → every client in the room, in its codec, with its own ack ----------
  function wireMatch(match) {
    match.on('snapshot', (snap) => {
      const sockets = socketsByRoom.get(match.roomId);
      if (!sockets?.size) return;
      // Binary: encode once, then patch the 4-byte ack (offset 6) per client.
      let binary = null;
      for (const socket of sockets) {
        const ack = match.ackFor(socket.state.id);
        let data;
        if (socket.state.codec === 'binary') {
          binary ??= binaryCodec.encodeSnapshot({ ...snap, ack: 0 });
          data = binary.slice();
          new DataView(data.buffer).setUint32(6, ack, true);
        } else {
          data = jsonCodec.encodeSnapshot({ ...snap, ack });
        }
        send(socket, data, { unreliable: true });
      }
    });
  }

  // ---------- connections ----------
  wss.on('connection', (socket, req) => {
    const state = {
      id: randomUUID().slice(0, 8),
      ip: req.socket.remoteAddress,
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
    socket.state = state;
    stats.connections++;
    log.info('ws connected', { id: state.id, ip: state.ip });

    // ALWAYS: an 'error' without a listener would throw and take the whole server down.
    socket.on('error', (err) => log.warn('ws error', { id: state.id, err: err.message }));

    const reject = (code, message) => {
      log.warn('ws rejected', { id: state.id, code, reason: message });
      if (socket.readyState === socket.OPEN) socket.send(encode('error', { code, message }));
      socket.close(code, message.slice(0, 120)); // close reason is limited to 123 bytes
    };

    const joinTimer = setTimeout(() => {
      if (!state.player) reject(CLOSE.JOIN_TIMEOUT, `no join within ${config.joinTimeoutMs} ms`);
    }, config.joinTimeoutMs);

    socket.on('pong', () => {
      state.missedPongs = 0;
    });

    function handle(data, isBinary) {
      if (socket.readyState !== socket.OPEN) return;
      const parsed = parseClientMessage(data, isBinary);
      if (!parsed.ok) return reject(parsed.code, parsed.reason);
      const msg = parsed.msg;
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
        send(
          socket,
          encode('welcome', { playerId: state.id, room: room.toJSON(), tickRate: TICK_RATE }),
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

      const room = rooms.get(state.roomId);
      switch (msg.type) {
        case 'inputs':
          matches.get(state.roomId)?.pushInputs(state.id, msg.inputs);
          break;
        case 'ping':
          send(socket, encode('pong', { t: msg.t, tick: matches.get(state.roomId)?.tick ?? 0 }), {
            critical: true,
          });
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
      }
    }

    socket.on('message', (data, isBinary) => {
      state.bytesIn += data.length;
      stats.bytesIn += data.length;
      const isInput = isBinary || (data.length < 600 && data.includes('"inputs"'));
      if (isInput && dropped(state)) return; // simulated packet loss (inputs only)
      const delay = netDelay(state, 'inAt');
      if (delay > 0) setTimeout(() => handle(data, isBinary), delay);
      else handle(data, isBinary);
    });

    socket.on('close', (code) => {
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
  // Dead TCP connections (laptop lid closed, NAT dropped the mapping) never send a close frame.
  // Protocol-level ping/pong finds them; two missed pongs in a row → terminate.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.state.missedPongs >= 2) {
        log.warn('heartbeat: terminating dead socket', { id: socket.state.id });
        socket.terminate();
        continue;
      }
      socket.state.missedPongs++;
      socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    wireMatch,

    connectionStats() {
      return [...wss.clients].map((s) => {
        const secs = Math.max(1, (Date.now() - s.state.connectedAt) / 1000);
        return {
          id: s.state.id,
          room: s.state.roomId,
          codec: s.state.codec,
          netsim: s.state.netsim,
          kbInPerS: +(s.state.bytesIn / 1024 / secs).toFixed(2),
          kbOutPerS: +(s.state.bytesOut / 1024 / secs).toFixed(2),
          dropped: s.state.dropped,
        };
      });
    },

    /** Graceful shutdown: tell every client we're going away (1001). Resolves when all closed. */
    closeAll() {
      clearInterval(heartbeat);
      const closed = [...wss.clients].map(
        (socket) =>
          new Promise((resolve) => {
            socket.once('close', resolve);
            socket.close(CLOSE.GOING_AWAY, 'server shutting down');
          }),
      );
      return Promise.all(closed);
    },
  };
}
