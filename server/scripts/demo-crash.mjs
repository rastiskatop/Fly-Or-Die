// "One unhandled error takes the whole server down" — and the fix (Lab 4, M4).
// For each case: start the server, call /api/debug/crash, show the server's log and exit code.
//   node scripts/demo-crash.mjs
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

async function scenario(query) {
  const child = fork(join(import.meta.dirname, '..', 'src', 'index.js'), [], {
    env: { ...process.env, PORT: '0', DEBUG_ROUTES: 'true' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const [{ port }] = await once(child, 'message');
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/api/debug/crash?${query}`);
  const exited = once(child, 'exit');
  const alive = await Promise.race([
    exited.then(() => false),
    new Promise((r) => setTimeout(r, 700)).then(async () => (await fetch(`${base}/health`)).ok),
  ]);
  if (alive) child.send({ type: 'shutdown' });
  const [code] = await exited;

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
