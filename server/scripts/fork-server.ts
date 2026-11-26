// Forks the real server (src/index.ts) for the measurement scripts and waits for its IPC
// "listening" message. The message crosses a process boundary, so it is validated, not trusted.
import { fork, type ChildProcess, type StdioOptions } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { z } from 'zod';

const ListeningSchema = z.object({
  type: z.literal('listening'),
  port: z.number().int().positive(),
});

export interface ForkedServer {
  readonly child: ChildProcess;
  readonly port: number;
  readonly base: string;
  /** Graceful shutdown over IPC; resolves with the exit code. */
  stop(): Promise<number | null>;
}

export async function forkServer(
  env: Readonly<Record<string, string>> = {},
  stdio: StdioOptions = ['ignore', 'ignore', 'inherit', 'ipc'],
): Promise<ForkedServer> {
  const child = fork(join(import.meta.dirname, '..', 'src', 'index.ts'), [], {
    env: { ...process.env, PORT: '0', ...env },
    stdio,
  });
  const [msg] = await once(child, 'message');
  const { port } = ListeningSchema.parse(msg);
  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      const exited = once(child, 'exit');
      child.send({ type: 'shutdown' });
      const [code] = await exited;
      return typeof code === 'number' ? code : null;
    },
  };
}

/** Exit code of a child that may already be on its way out. */
export async function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const [code] = await once(child, 'exit');
  return typeof code === 'number' ? code : null;
}
