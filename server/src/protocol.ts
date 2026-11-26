// Lab 6: the hand-written validator from Lab 4 is gone. The protocol lives in
// @flyordie/shared/net/messages.ts as zod schemas — one definition gives the TypeScript types
// AND the runtime checks, for both directions. This file only adds the server-side frame logic.
import { binaryCodec } from '@flyordie/shared/net/codec.ts';
import {
  CLOSE,
  CreateRoomBodySchema,
  inputsOf,
  parseClientMessage,
  type ClientMessage,
  type CreateRoomBody,
  type Rejection,
  type Result,
} from '@flyordie/shared/net/messages.ts';
import type { Input } from '@flyordie/shared/net/protocol.ts';

export { CLOSE, serverMessage } from '@flyordie/shared/net/messages.ts';

/** What the connection handler dispatches on: JSON control messages plus decoded inputs. */
export type IncomingMessage =
  | Exclude<ClientMessage, { type: 'inputs' }>
  | { readonly type: 'inputs'; readonly inputs: Input[] };

/** One WebSocket frame → a typed message or a rejection (code + reason). Never throws. */
export function parseFrame(data: Buffer, isBinary: boolean): Result<IncomingMessage, Rejection> {
  if (isBinary) {
    // The only binary client message is INPUTS (spec: shared/src/net/codec-binary.ts).
    try {
      return { ok: true, value: { type: 'inputs', inputs: binaryCodec.decodeInputs(data) } };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: { code: CLOSE.BAD_MESSAGE, reason: `bad binary frame: ${reason}` },
      };
    }
  }
  const parsed = parseClientMessage(data.toString('utf8'));
  if (!parsed.ok) return parsed;
  const msg = parsed.value;
  return {
    ok: true,
    value: msg.type === 'inputs' ? { type: 'inputs', inputs: inputsOf(msg) } : msg,
  };
}

/** POST /api/rooms body. */
export function parseCreateRoom(body: unknown): Result<CreateRoomBody, string> {
  const parsed = CreateRoomBodySchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` };
}
