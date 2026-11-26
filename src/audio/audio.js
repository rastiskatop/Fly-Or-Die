// Owns the AudioContext. Plays decoded AudioBuffers with zero latency and unlimited overlap.
// Rule of the platform: a context created before a user gesture starts "suspended";
// it can only be resumed from inside a click/keydown handler — see unlock().
export function createAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = Ctx ? new Ctx() : null;
  const buffers = new Map();
  let master = null;
  let muted = false;

  if (ctx) {
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  }

  return {
    ctx,
    get state() {
      return ctx ? ctx.state : 'unsupported';
    },
    get muted() {
      return muted;
    },

    setBuffers(sounds) {
      for (const [name, buffer] of Object.entries(sounds)) if (buffer) buffers.set(name, buffer);
    },

    /** Call from a user-gesture handler. Resolves when audio is actually running. */
    async unlock() {
      if (ctx && ctx.state === 'suspended') await ctx.resume();
    },

    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.6;
      return muted;
    },

    /** Fire-and-forget: one new AudioBufferSourceNode per play (they're single-use and cheap). */
    play(name, { volume = 1, pan = 0, rate = 1 } = {}) {
      const buffer = buffers.get(name);
      if (!ctx || !buffer || ctx.state !== 'running') return; // missing sound = silence, not a crash
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(gain).connect(panner).connect(master);
      src.start();
    },
  };
}

/**
 * Subscribes the audio module to simulation events. The sim never imports this file:
 * it only dispatches CustomEvents on the World (an EventTarget).
 * Returns nothing; pass a `signal` to unsubscribe everything at once.
 */
export function attachAudio(world, audio, { signal } = {}) {
  const panOf = (x) => (x / world.width) * 2 - 1;
  const on = (type, fn) => world.addEventListener(type, (e) => fn(e.detail), { signal });

  on('fired', ({ x, fast }) =>
    audio.play(fast ? 'shoot_fast' : 'shoot', {
      volume: 0.35,
      pan: panOf(x),
      rate: 0.95 + Math.random() * 0.1,
    }),
  );
  on('hit', ({ x, kind }) =>
    audio.play('hit', { volume: kind === 'ship' ? 0.8 : 0.4, pan: panOf(x) }),
  );
  on('exploded', ({ x, kind, size }) => {
    if (kind === 'ship') audio.play('explode_big', { volume: 1, pan: panOf(x) });
    else
      audio.play('explode', { volume: 0.4 + size * 0.2, pan: panOf(x), rate: 1.3 - size * 0.15 });
  });
  on('pickup', ({ x }) => audio.play('pickup', { volume: 0.7, pan: panOf(x) }));
  on('respawned', ({ x }) => audio.play('respawn', { volume: 0.6, pan: panOf(x) }));
}
