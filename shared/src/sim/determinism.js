import { createMatchWorld, spawnPlayerShip } from './game.js';
import { DEFAULT_ARENA } from './game.js';
import { DT, buttonsToControls } from '../net/protocol.js';

/**
 * Runs the full shared simulation for `steps` fixed steps with scripted inputs for two ships and
 * returns a hash of the final state. Same code, same inputs → the same hash in Node AND in the
 * browser (the client shows it with ?demo=determinism). If anything non-deterministic sneaks into
 * the sim (Math.random, Date.now, iteration order), the hashes stop matching.
 */
export function simulationHash(
  steps = 1000,
  { width = 1280, height = 720, arena = DEFAULT_ARENA } = {},
) {
  const world = createMatchWorld({ width, height, arena });
  const a = spawnPlayerShip(world, 'A');
  const b = spawnPlayerShip(world, 'B');
  for (let i = 0; i < steps; i++) {
    // scripted, deterministic "pilots"
    const ba = (i % 90 < 50 ? 4 : 0) | (i % 40 < 12 ? 1 : 0) | (i % 7 === 0 ? 8 : 0);
    const bb = (i % 60 < 40 ? 4 : 0) | (i % 50 < 20 ? 2 : 0) | (i % 5 === 0 ? 8 : 0);
    a.inputSeq = b.inputSeq = i + 1;
    world.step(
      DT,
      new Map([
        [a.id, buttonsToControls(ba)],
        [b.id, buttonsToControls(bb)],
      ]),
    );
  }
  return hashWorld(world);
}

/** FNV-1a over the exact bits of every number in the world state. */
export function hashWorld(world) {
  const f64 = new Float64Array(1);
  const bytes = new Uint8Array(f64.buffer);
  let h = 0x811c9dc5;
  const mix = (n) => {
    f64[0] = n;
    for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  };
  let count = 0;
  for (const e of world) {
    count++;
    // not e.id: ids come from a process-wide counter, so they depend on what ran before
    mix(e.pos.x);
    mix(e.pos.y);
    mix(e.vel.x);
    mix(e.vel.y);
    mix(e.angle);
    if (e.kind === 'ship') {
      mix(e.hp);
      mix(e.score);
    }
  }
  return { hash: h.toString(16).padStart(8, '0'), entities: count, tick: world.tick };
}
