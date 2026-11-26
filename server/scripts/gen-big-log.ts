// Generates a synthetic match log of ~SIZE_MB megabytes in LOG_DIR, using the SAME stream chain as
// real match logs (generator → Readable.from → NdjsonEncoder → file). Memory stays flat while
// writing because pipeline() pauses the generator whenever the file stream's buffer is full.
//   node scripts/gen-big-log.ts [sizeMB=200]
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NdjsonEncoder } from '../src/log/matchlog.ts';
import { loadConfig } from '../src/config.ts';

const sizeMB = Number(process.argv[2] ?? 200);
const { logDir } = loadConfig();
await mkdir(logDir, { recursive: true });
const id = `synthetic-${sizeMB}mb`;
const file = join(logDir, `${id}.ndjson`);

function* events() {
  // ~210 bytes per line → 200 MB ≈ 1M events
  const target = sizeMB * 2 ** 20;
  let bytes = 0;
  let seq = 0;
  let peakRss = 0;
  while (bytes < target) {
    const e = {
      seq,
      t: seq * 16,
      type: seq % 10 === 0 ? 'chat' : 'snapshot',
      room: 'synthetic',
      ship: {
        x: +(Math.sin(seq / 50) * 600 + 640).toFixed(2),
        y: +(Math.cos(seq / 70) * 300 + 360).toFixed(2),
      },
      vel: { x: +Math.sin(seq).toFixed(3), y: +Math.cos(seq).toFixed(3) },
      text: seq % 10 === 0 ? `message number ${seq}` : undefined,
      pad: 'x'.repeat(64),
    };
    bytes += JSON.stringify(e).length + 1;
    seq++;
    if (seq % 100000 === 0) {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      process.stdout.write(
        `\r${(bytes / 2 ** 20).toFixed(0)} MB, rss ${(peakRss / 2 ** 20).toFixed(0)} MB   `,
      );
    }
    yield e;
  }
}

const t0 = performance.now();
await pipeline(Readable.from(events()), new NdjsonEncoder(), createWriteStream(file));
const { size } = await stat(file);
console.log(
  `\nwrote ${file}\n${(size / 2 ** 20).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s, ` +
    `peak rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB → replay id: ${id}`,
);
