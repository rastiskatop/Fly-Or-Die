// The JSON-vs-binary switch as an interface with two implementations. Callers hold a `Codec`
// and never branch on the format; the frame type follows the codec (Uint8Array or string).
import * as binary from './codec-binary.ts';
import * as json from './codec-json.ts';
import type { Input, Snapshot } from './protocol.ts';
import type { CodecName } from './messages.ts';

/**
 * Out: what encoders produce. In: what decoders accept — wider for binary, because a received
 * frame may be a view into someone else's buffer (a Node Buffer lives in a shared pool), while
 * an encoded frame always owns a fresh ArrayBuffer.
 */
export interface Codec<Out, In = Out> {
  readonly name: CodecName;
  encodeInputs(inputs: readonly Input[]): Out;
  /** Validating: throws on malformed input (callers decide whether that closes the socket). */
  decodeInputs(frame: In): Input[];
  encodeSnapshot(snapshot: Snapshot): Out;
  decodeSnapshot(frame: In): Snapshot;
}

export const binaryCodec: Codec<Uint8Array<ArrayBuffer>, binary.BinaryData> = {
  name: 'binary',
  ...binary,
};
export const jsonCodec: Codec<string> = { name: 'json', ...json };

export type AnyCodec = typeof binaryCodec | typeof jsonCodec;

export function codecFor(name: CodecName): AnyCodec {
  switch (name) {
    case 'binary':
      return binaryCodec;
    case 'json':
      return jsonCodec;
    default: {
      const unreachable: never = name;
      return unreachable;
    }
  }
}
