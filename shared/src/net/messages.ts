// Control messages (JSON text frames), both directions — the single source of truth.
// zod schema → inferred TypeScript type → runtime parsing at every boundary (server: every
// client frame; client: every server frame). Lab 4's hand-written validate() is gone.
import { z } from 'zod';
import { EntityIdSchema, SeqSchema, TickSchema } from '../ids.ts';
import { ButtonsSchema, SnapshotSchema, type Input } from './protocol.ts';

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes. 4000–4999 are free for applications (RFC 6455 §7.4.2). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down
  POLICY: 1008, // rate limit exceeded
  TOO_BIG: 1009, // set by `ws` itself when maxPayload is exceeded
  BAD_MESSAGE: 4000, // not JSON / wrong shape / binary garbage
  UNKNOWN_TYPE: 4001,
  BAD_VERSION: 4002,
  JOIN_TIMEOUT: 4003,
  JOIN_REFUSED: 4004, // room not found / full
  SLOW_CLIENT: 4005,
  HEARTBEAT: 4006,
});
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

export const LIMITS = Object.freeze({ name: 16, chat: 200, roomId: 32 });

// Printable characters only: no control/format chars (newlines, RTL overrides…) in names or chat.
const printable = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'printable characters only');

export const RoomIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/, 'room id');
export const CodecNameSchema = z.enum(['binary', 'json']);
export type CodecName = z.infer<typeof CodecNameSchema>;

// ---------- client → server ----------
const v = { v: z.literal(PROTOCOL_VERSION) };
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    ...v,
    type: z.literal('join'),
    room: RoomIdSchema,
    name: printable(LIMITS.name),
    codec: CodecNameSchema.default('json'),
  }),
  z.object({ ...v, type: z.literal('chat'), text: printable(LIMITS.chat) }),
  z.object({ ...v, type: z.literal('leave') }),
  z.object({ ...v, type: z.literal('ping'), t: z.number() }),
  z.object({
    ...v,
    type: z.literal('netsim'),
    lagMs: z.number().min(0).max(1000),
    jitterMs: z.number().min(0).max(500),
    dropPct: z.number().min(0).max(50),
  }),
  // JSON-codec inputs: [seq, buttons] pairs (the binary codec has its own frame)
  z.object({
    ...v,
    type: z.literal('inputs'),
    inputs: z
      .array(z.tuple([SeqSchema, ButtonsSchema]))
      .min(1)
      .max(8),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];
/** What a client SENDS: the schema's input type (defaults like codec are optional), minus the stamped version. */
export type OutgoingClientMessage = DistributiveOmit<z.input<typeof ClientMessageSchema>, 'v'>;
export const CLIENT_MESSAGE_TYPES = [
  'join',
  'chat',
  'leave',
  'ping',
  'netsim',
  'inputs',
] as const satisfies readonly ClientMessageType[];

/** Result instead of exceptions for untrusted input: the caller MUST look at `ok`. */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export interface Rejection {
  readonly code: CloseCode;
  readonly reason: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Parses one JSON text frame from a client. Never throws: bad input → { ok: false, error: {code, reason} }
 * and the server logs it and closes the socket with that code.
 */
export function parseClientMessage(text: string): Result<ClientMessage, Rejection> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: CLOSE.BAD_MESSAGE, reason: 'not valid JSON' } };
  }
  if (!isRecord(json))
    return {
      ok: false,
      error: { code: CLOSE.BAD_MESSAGE, reason: 'message must be a JSON object' },
    };
  if (json.v !== PROTOCOL_VERSION)
    return {
      ok: false,
      error: { code: CLOSE.BAD_VERSION, reason: `unsupported protocol version ${String(json.v)}` },
    };
  const type = json.type;
  if (typeof type !== 'string' || !CLIENT_MESSAGE_TYPES.some((t) => t === type))
    return {
      ok: false,
      error: { code: CLOSE.UNKNOWN_TYPE, reason: `unknown type "${String(type)}"` },
    };
  const parsed = ClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || type;
    return {
      ok: false,
      error: {
        code: CLOSE.BAD_MESSAGE,
        reason: `${type}.${where}: ${issue?.message ?? 'invalid'}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/** JSON inputs message → the codec-neutral Input list. */
export function inputsOf(msg: Extract<ClientMessage, { type: 'inputs' }>): Input[] {
  return msg.inputs.map(([seq, buttons]) => ({ seq, buttons }));
}

// ---------- server → client ----------
export const RoomInfoSchema = z.object({
  id: RoomIdSchema,
  name: z.string(),
  arena: z.string(),
  region: z.string(),
  players: z.number().int().min(0),
  maxPlayers: z.number().int().min(1),
});
export type RoomInfo = z.infer<typeof RoomInfoSchema>;

export const RosterPlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  shipId: EntityIdSchema.optional(),
});
export type RosterPlayer = z.infer<typeof RosterPlayerSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    ...v,
    type: z.literal('welcome'),
    playerId: z.string(),
    room: RoomInfoSchema,
    tickRate: z.number(),
  }),
  z.object({ ...v, type: z.literal('roster'), players: z.array(RosterPlayerSchema) }),
  z.object({
    ...v,
    type: z.literal('chat'),
    from: z.object({ id: z.string(), name: z.string() }),
    text: z.string(),
    t: z.number(),
  }),
  z.object({ ...v, type: z.literal('system'), text: z.string(), t: z.number() }),
  z.object({ ...v, type: z.literal('error'), code: z.number(), message: z.string() }),
  z.object({ ...v, type: z.literal('pong'), t: z.number(), tick: TickSchema }),
  z.object({ ...v, type: z.literal('snapshot'), ...SnapshotSchema.shape }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/**
 * { welcome: WelcomeMessage, roster: RosterMessage, … } — a map from each message's `type`
 * to that message, built by key-remapping the union. The client's typed Bus uses it, so
 * `conn.on('roster', m => m.players)` knows m is the roster message.
 */
export type ServerEvents = { [M in ServerMessage as M['type']]: M };

/**
 * Omit that distributes over a union. Plain `Omit<A | B, 'v'>` keeps only the keys A and B share
 * (so `{ type: 'roster', players }` would be rejected); this applies Omit to each member separately.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OutgoingServerMessage = DistributiveOmit<ServerMessage, 'v'>;

/** Builds a server → client message: the version is stamped, the shape checked by the compiler. */
export function serverMessage(msg: OutgoingServerMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
}

// ---------- HTTP ----------
export const RoomsResponseSchema = z.object({
  rooms: z.array(RoomInfoSchema),
  serverTime: z.number().optional(),
});
export const CreateRoomBodySchema = z.object({
  name: printable(32),
  arena: z.enum(['classic', 'rocks', 'calm']).default('classic'),
});
export type CreateRoomBody = z.infer<typeof CreateRoomBodySchema>;

export const HealthSchema = z
  .object({ status: z.literal('ok'), service: z.literal('flyordie') })
  .loose();
