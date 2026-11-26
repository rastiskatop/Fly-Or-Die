// JSON codec — same API as codec-binary.js, kept for comparison (?codec=json).
// Text frames; numbers go through number→string→number on every message.

export function encodeInputs(inputs) {
  return JSON.stringify({ v: 1, type: 'inputs', inputs: inputs.map((i) => [i.seq, i.buttons]) });
}

export function decodeInputs(data) {
  const m = typeof data === 'string' ? JSON.parse(data) : data;
  if (
    m?.type !== 'inputs' ||
    !Array.isArray(m.inputs) ||
    m.inputs.length < 1 ||
    m.inputs.length > 8
  )
    throw new Error('bad inputs message');
  return m.inputs.map((pair) => ({ seq: pair?.[0], buttons: pair?.[1] }));
}

export function encodeSnapshot(snap) {
  return JSON.stringify({ type: 'snapshot', ...snap });
}

export function decodeSnapshot(data) {
  const m = JSON.parse(data);
  if (m.type !== 'snapshot') throw new Error('not a snapshot');
  return { tick: m.tick, ack: m.ack, entities: m.entities, events: m.events };
}
