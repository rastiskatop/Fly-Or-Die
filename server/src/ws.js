import { randomUUID } from 'node:crypto';
import { parseClientMessage, encode, CLOSE } from './protocol.js';
import { TokenBucket } from './rate-limit.js';
import { log } from './logger.js';

/**
 * Connection lifecycle for every WebSocket:
 *
 *   connect ──(join within JOIN_TIMEOUT_MS)──▶ in room ──(leave / close / error)──▶ gone
 *      │                                          │
 *      └─ no join in time → close 4003            ├─ every message: rate limit → validate → dispatch
 *                                                 └─ heartbeat: ping every HEARTBEAT_MS, 2 missed pongs → terminate
 *
 * Per-socket state lives in a WeakMap-free plain object attached as `socket.state`.
 */
export function attachWebSockets(wss, { rooms, config, stats }) {
  // ---------- room → sockets broadcast ----------
  const socketsByRoom = new Map(); // roomId -> Set<socket>

  function roomSockets(roomId) {
    let set = socketsByRoom.get(roomId);
    if (!set) socketsByRoom.set(roomId, (set = new Set()));
    return set;
  }

  /**
   * Slow-client policy. bufferedAmount = bytes queued in this process for that socket but not yet
   * handed to the network — it grows when the client (or its link) can't keep up.
   *  - over the threshold: drop NON-critical messages (chat, system) for that client
   *  - over 4× the threshold: the client is hopeless → terminate it
   * Critical messages (welcome, roster, error) are always sent.
   */
  function send(socket, data, { critical = false } = {}) {
    if (socket.readyState !== socket.OPEN) return false;
    const queued = socket.bufferedAmount;
    if (queued > config.slowClientBytes * 4) {
      log.warn('slow client terminated', { id: socket.state.id, buffered: queued });
      socket.close(CLOSE.SLOW_CLIENT, 'too slow');
      setTimeout(() => socket.terminate(), 1000).unref();
      return false;
    }
    if (!critical && queued > config.slowClientBytes) {
      socket.state.dropped++;
      stats.dropped++;
      return false;
    }
    socket.send(data);
    return true;
  }

  function broadcast(roomId, data, opts) {
    for (const s of socketsByRoom.get(roomId) ?? []) send(s, data, opts);
  }

  // The room's own events drive the broadcasts: ws.js never decides WHAT happened, the Room does.
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

  // ---------- connections ----------
  wss.on('connection', (socket, req) => {
    const state = {
      id: randomUUID().slice(0, 8),
      ip: req.socket.remoteAddress,
      player: null,
      roomId: null,
      missedPongs: 0,
      dropped: 0,
      bucket: new TokenBucket({ ratePerSec: config.rateLimitPerSec, burst: config.rateLimitBurst }),
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

    socket.on('message', (data, isBinary) => {
      if (!state.bucket.take()) return reject(CLOSE.POLICY, 'rate limit exceeded');
      const parsed = parseClientMessage(data, isBinary);
      if (!parsed.ok) return reject(parsed.code, parsed.reason);
      const msg = parsed.msg;

      if (!state.player) {
        if (msg.type !== 'join') return reject(CLOSE.BAD_MESSAGE, 'first message must be join');
        const room = rooms.get(msg.room);
        if (!room) return reject(CLOSE.JOIN_REFUSED, `room ${msg.room} not found`);
        if (room.full) return reject(CLOSE.JOIN_REFUSED, `room ${room.name} is full`);
        clearTimeout(joinTimer);
        state.player = { id: state.id, name: msg.name, joinedAt: Date.now() };
        state.roomId = room.id;
        roomSockets(room.id).add(socket);
        send(socket, encode('welcome', { playerId: state.id, room: room.toJSON() }), {
          critical: true,
        });
        room.join(state.player); // → 'join' → roster + system broadcast (including to us)
        log.info('player joined', { id: state.id, name: msg.name, room: room.id });
        return;
      }

      const room = rooms.get(state.roomId);
      switch (msg.type) {
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
