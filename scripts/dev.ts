// `npm run dev`: starts the game server and the Vite client together, prefixes their output,
// and stops both on Ctrl+C. (Same as running `npm run dev:server` and `npm run dev:client`
// in two terminals.)
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

// The game server's port is set explicitly: a PORT inherited from the shell (or from a tool that
// launched us) would otherwise make the server grab Vite's port.
const SERVER_PORT = process.env.SERVER_PORT ?? '8787';

const procs = [
  { name: 'server', color: 36, cmd: 'npm run dev -w server', env: { PORT: SERVER_PORT } },
  { name: 'client', color: 35, cmd: 'npm run dev -w client', env: { SERVER_PORT } },
].map(({ name, color, cmd, env }) => {
  const child = spawn(cmd, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const relay = (stream: Readable, out: Writable): void => {
    stream.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) if (line) out.write(prefix + line + '\n');
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code ?? 'null'}`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll(): void {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill('SIGINT');
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
