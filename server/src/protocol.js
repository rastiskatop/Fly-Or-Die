// Protocol v1: JSON text frames, every message has { v, type }.
// The server validates EVERY incoming message — the client is not trusted, even though we wrote it
// (anyone can open a WebSocket from the console or a script).
//
// client → server
//   { v: 1, type: 'join', room: 'eu-1', name: 'Pilot42' }
//   { v: 1, type: 'chat', text: 'hi' }
//   { v: 1, type: 'leave' }
// server → client
//   { v: 1, type: 'welcome', playerId, room: { id, name, arena, maxPlayers } }
//   { v: 1, type: 'roster', players: [{ id, name }] }
//   { v: 1, type: 'chat', from: { id, name }, text, t }
//   { v: 1, type: 'system', text, t }
//   { v: 1, type: 'error', code, message }   (then the server closes the socket)

import { decodeInputs as decodeBinaryInputs } from '@flyordie/shared/net/codec-binary.js';
import { decodeInputs as decodeJsonInputs } from '@flyordie/shared/net/codec-json.js';
import { isValidInput } from '@flyordie/shared/net/protocol.js';

// Lab 5 additions (still v1 for control messages):
//   client → server   join { …, codec: 'binary'|'json' }   ping { t }   netsim { lagMs, jitterMs, dropPct }
//                     inputs — BINARY frame (shared/src/net/codec-binary.js) or JSON { type:'inputs' }
//   server → client   welcome { …, tickRate }   pong { t, tick }   roster players[].shipId
//                     snapshot — BINARY frame or JSON { type:'snapshot' } (per the client's codec)

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes. 4000–4999 are free for applications (RFC 6455 §7.4.2). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down
  POLICY: 1008, // rate limit exceeded
  TOO_BIG: 1009, // set by `ws` itself when maxPayload is exceeded
  BAD_MESSAGE: 4000, // not JSON / wrong shape / binary
  UNKNOWN_TYPE: 4001,
  BAD_VERSION: 4002,
  JOIN_TIMEOUT: 4003,
  JOIN_REFUSED: 4004, // room not found / full
  SLOW_CLIENT: 4005,
  HEARTBEAT: 4006,
});

export const LIMITS = Object.freeze({ name: 16, chat: 200, roomId: 32 });

const ROOM_ID = /^[a-z0-9-]{1,32}$/;
// Printable characters only: no control chars / newlines in names or chat
const PRINTABLE = /^[^\p{Cc}\p{Cf}]+$/u;

const fail = (code, reason) => ({ ok: false, code, reason });

const schemas = {
  join(m) {
    if (typeof m.room !== 'string' || !ROOM_ID.test(m.room)) return 'join.room must be a room id';
    if (typeof m.name !== 'string') return 'join.name must be a string';
    const name = m.name.trim();
    if (name.length < 1 || name.length > LIMITS.name || !PRINTABLE.test(name))
      return `join.name must be 1..${LIMITS.name} printable chars`;
    const codec = m.codec ?? 'json';
    if (codec !== 'json' && codec !== 'binary') return 'join.codec must be "binary" or "json"';
    return { type: 'join', room: m.room, name, codec };
  },
  chat(m) {
    if (typeof m.text !== 'string') return 'chat.text must be a string';
    const text = m.text.trim();
    if (text.length < 1 || text.length > LIMITS.chat || !PRINTABLE.test(text))
      return `chat.text must be 1..${LIMITS.chat} printable chars`;
    return { type: 'chat', text };
  },
  leave() {
    return { type: 'leave' };
  },
  ping(m) {
    if (!Number.isFinite(m.t)) return 'ping.t must be a number';
    return { type: 'ping', t: m.t };
  },
  netsim(m) {
    const ok = (v, max) => Number.isFinite(v) && v >= 0 && v <= max;
    if (!ok(m.lagMs, 1000) || !ok(m.jitterMs, 500) || !ok(m.dropPct, 50))
      return 'netsim: lagMs 0..1000, jitterMs 0..500, dropPct 0..50';
    return { type: 'netsim', lagMs: m.lagMs, jitterMs: m.jitterMs, dropPct: m.dropPct };
  },
  inputs(m) {
    try {
      return checkInputs(decodeJsonInputs(m));
    } catch (err) {
      return err.message;
    }
  },
};

function checkInputs(inputs) {
  if (!inputs.every(isValidInput)) return 'inputs: seq must be a positive u32, buttons 0..15';
  return { type: 'inputs', inputs };
}

/**
 * Parses and validates one raw frame.
 * Returns { ok: true, msg } with a CLEAN copy (only known fields), or { ok: false, code, reason }.
 */
export function parseClientMessage(data, isBinary) {
  if (isBinary) {
    // The only binary client message is INPUTS (see the spec in shared/src/net/codec-binary.js).
    try {
      const result = checkInputs(decodeBinaryInputs(data));
      return typeof result === 'string'
        ? fail(CLOSE.BAD_MESSAGE, result)
        : { ok: true, msg: result };
    } catch (err) {
      return fail(CLOSE.BAD_MESSAGE, `bad binary frame: ${err.message}`);
    }
  }
  let m;
  try {
    m = JSON.parse(data.toString('utf8'));
  } catch {
    return fail(CLOSE.BAD_MESSAGE, 'not valid JSON');
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m))
    return fail(CLOSE.BAD_MESSAGE, 'message must be a JSON object');
  if (m.v !== PROTOCOL_VERSION)
    return fail(CLOSE.BAD_VERSION, `unsupported protocol version ${m.v}`);
  if (!Object.hasOwn(schemas, m.type)) return fail(CLOSE.UNKNOWN_TYPE, `unknown type "${m.type}"`);
  const result = schemas[m.type](m);
  if (typeof result === 'string') return fail(CLOSE.BAD_MESSAGE, result);
  return { ok: true, msg: result };
}

/** Server → client: stamps the version so every outgoing message is well-formed. */
export function encode(type, fields = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...fields });
}

/** Validation for POST /api/rooms. */
export function parseCreateRoom(body, arenas) {
  if (body === null || typeof body !== 'object') return 'body must be a JSON object';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 32 || !PRINTABLE.test(name))
    return 'name must be 1..32 printable chars';
  const arena = body.arena ?? 'classic';
  if (!arenas.includes(arena)) return `arena must be one of: ${arenas.join(', ')}`;
  return { name, arena };
}
