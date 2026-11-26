import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/** `catch (err)` is `unknown`: narrow before reading `.code`. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

const REPLAY_ID = /^[a-z0-9_-]{1,80}$/i;

/** Safe path for a replay id — the id is user input, so no "../" ever reaches the filesystem. */
export function replayPath(dir: string, id: string): string | null {
  if (!REPLAY_ID.test(id)) return null;
  return join(dir, `${id}.ndjson`);
}

/**
 * Async generator over an NDJSON file: reads it as a stream, splits lines, yields parsed events.
 * Memory use is one line at a time, whatever the file size.
 */
/** Events are `unknown`: a log file is input like any other, validate before trusting it. */
export async function* readReplay(file: string): AsyncGenerator<unknown> {
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

export interface ReplayInfo {
  readonly id: string;
  readonly bytes: number;
  readonly modified: string;
}

export async function listReplays(dir: string): Promise<ReplayInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
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
