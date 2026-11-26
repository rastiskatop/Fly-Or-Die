import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const REPLAY_ID = /^[a-z0-9_-]{1,80}$/i;

/** Safe path for a replay id — the id is user input, so no "../" ever reaches the filesystem. */
export function replayPath(dir, id) {
  if (!REPLAY_ID.test(id)) return null;
  return join(dir, `${id}.ndjson`);
}

/**
 * Async generator over an NDJSON file: reads it as a stream, splits lines, yields parsed events.
 * Memory use is one line at a time, whatever the file size.
 */
export async function* readReplay(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      throw new Error(`${file}:${lineNo}: invalid JSON line`);
    }
  }
}

export async function listReplays(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const replays = await Promise.all(
    names
      .filter((n) => n.endsWith('.ndjson'))
      .map(async (n) => {
        const s = await stat(join(dir, n));
        return {
          id: n.slice(0, -'.ndjson'.length),
          bytes: s.size,
          modified: s.mtime.toISOString(),
        };
      }),
  );
  return replays.sort((a, b) => b.modified.localeCompare(a.modified));
}
