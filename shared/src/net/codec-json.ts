// JSON codec — same interface as codec-binary.ts, kept for comparison (?codec=json).
// Text frames; numbers go through number→string→number on every message. Decoding validates
// with the same zod schemas that define the types (protocol.ts / messages.ts).
import { InputSchema, SnapshotSchema, type Input, type Snapshot } from './protocol.ts';
import { PROTOCOL_VERSION } from './messages.ts';
import { z } from 'zod';

const InputsFrame = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('inputs'),
  inputs: z
    .array(z.tuple([z.number(), z.number()]))
    .min(1)
    .max(8),
});
const SnapshotFrame = SnapshotSchema.extend({ type: z.literal('snapshot') });

export function encodeInputs(inputs: readonly Input[]): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'inputs',
    inputs: inputs.map((i) => [i.seq, i.buttons]),
  });
}

export function decodeInputs(text: string): Input[] {
  const frame = InputsFrame.parse(JSON.parse(text));
  return frame.inputs.map(([seq, buttons]) => InputSchema.parse({ seq, buttons }));
}

export function encodeSnapshot(snap: Snapshot): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'snapshot', ...snap });
}

export function decodeSnapshot(text: string): Snapshot {
  const { tick, ack, entities, events } = SnapshotFrame.parse(JSON.parse(text));
  return { tick, ack, entities, events };
}
