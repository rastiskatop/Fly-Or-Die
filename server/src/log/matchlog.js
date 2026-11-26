import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { on } from 'node:events';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

/**
 * Object-mode Transform: objects in (writable side), NDJSON text out (readable side).
 * One JSON document per line — appendable, streamable, greppable, and a crash leaves
 * every complete line still valid.
 */
export class NdjsonEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }

  _transform(obj, _encoding, callback) {
    try {
      callback(null, JSON.stringify(obj) + '\n');
    } catch (err) {
      callback(err); // e.g. a circular object: the pipeline fails loudly instead of writing garbage
    }
  }
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * Streams one match of a room to LOG_DIR/<room>-<timestamp>.ndjson:
 *
 *   room 'event'  →  events.on() async iterator  →  Readable.from  →  NdjsonEncoder  →  file
 *
 * pipeline() wires backpressure (if the disk is slow, reading from the iterator pauses and the
 * iterator buffers) and error propagation + cleanup of all three streams.
 * The iteration ends on the room's 'matchEnd' event (`close` option) → pipeline finishes → file flushed.
 *
 * Deliberately synchronous: an `await` before on() would let the room emit its first events
 * (match_start, join) before we subscribe. LOG_DIR is created once at startup.
 */
export function startMatchLog(room, dir) {
  // Subscribe NOW (synchronously, before anything else can emit). A generator that called on()
  // inside its body would only subscribe once the stream starts reading — and miss the first events.
  const iterator = on(room, 'event', { close: ['matchEnd'] });
  const id = `${room.id}-${stamp()}-${room.matchId}`;
  const file = join(dir, `${id}.ndjson`);

  async function* events() {
    for await (const [event] of iterator) yield event;
  }

  const done = pipeline(Readable.from(events()), new NdjsonEncoder(), createWriteStream(file));
  return { id, file, done };
}
