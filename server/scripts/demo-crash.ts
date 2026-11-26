// "One unhandled error takes the whole server down" — and the fix (Lab 4, M4).
// For each case: start the server, call /api/debug/crash, show the server's log and exit code.
//   node scripts/demo-crash.ts
import { forkServer, exitCode } from './fork-server.ts';

async function scenario(query: string): Promise<void> {
  const { child, base } = await forkServer({ DEBUG_ROUTES: 'true' }, [
    'ignore',
    'pipe',
    'pipe',
    'ipc',
  ]);
  let out = '';
  // stdout/stderr are typed `Readable | null` — null unless stdio says 'pipe', which it does here.
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));

  await fetch(`${base}/api/debug/crash?${query}`);
  const exited = exitCode(child);
  const alive = await Promise.race([
    exited.then(() => false),
    new Promise((r) => setTimeout(r, 700)).then(async () => (await fetch(`${base}/health`)).ok),
  ]);
  if (alive) child.send({ type: 'shutdown' });
  const code = await exited;

  console.log(
    `\n=== /api/debug/crash?${query} → ${alive ? 'server still serving /health' : 'SERVER DIED'} (exit code ${code})`,
  );
  console.log(
    out
      .split('\n')
      .filter((l) => /crash|error|FATAL|handled|shutting|bye|warn/i.test(l))
      .map((l) => '  ' + l)
      .join('\n'),
  );
}

await scenario('kind=emitter');
await scenario('kind=emitter&fixed=1');
await scenario('kind=rejection');
await scenario('kind=rejection&fixed=1');
