// Lab 7, M4 worker experiment: decode binary snapshots off the main thread.
// Message in:  { mode: 'objects' | 'soa', frame: ArrayBuffer }   (the frame is TRANSFERRED in)
// Message out: 'objects' → the decoded Snapshot (structured-CLONED back, a copy)
//              'soa'     → { tick, n, kind, id, x, y, angle } typed arrays (TRANSFERRED back, no copy)
import { decodeSnapshot } from '@flyordie/shared/net/codec-binary.ts';

const KIND = { ship: 1, bullet: 2, asteroid: 3, pickup: 4 } as const;

globalThis.addEventListener('message', (e: MessageEvent<unknown>) => {
  const msg: unknown = e.data;
  if (
    typeof msg !== 'object' ||
    msg === null ||
    !('frame' in msg) ||
    !(msg.frame instanceof ArrayBuffer)
  )
    return;
  const snap = decodeSnapshot(new Uint8Array(msg.frame));
  if (!('mode' in msg) || msg.mode !== 'soa') {
    globalThis.postMessage(snap);
    return;
  }
  const n = snap.entities.length;
  const kind = new Uint8Array(n);
  const id = new Uint16Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const angle = new Float32Array(n);
  snap.entities.forEach((ent, i) => {
    kind[i] = KIND[ent.kind];
    id[i] = ent.id;
    x[i] = ent.x;
    y[i] = ent.y;
    angle[i] = ent.angle;
  });
  globalThis.postMessage(
    { tick: snap.tick, n, kind, id, x, y, angle },
    { transfer: [kind.buffer, id.buffer, x.buffer, y.buffer, angle.buffer] },
  );
});
