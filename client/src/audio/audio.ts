import type { Bus, AbortSignalLike } from '@flyordie/shared/bus.ts';
import type { GameEvents } from '@flyordie/shared/sim/events.ts';

export type SoundName =
  'shoot' | 'shoot_fast' | 'hit' | 'explode' | 'explode_big' | 'pickup' | 'respawn';

export interface PlayOptions {
  volume?: number;
  pan?: number;
  rate?: number;
}

export interface Audio {
  readonly ctx: AudioContext | null;
  readonly state: AudioContextState | 'unsupported';
  readonly muted: boolean;
  setBuffers(sounds: Readonly<Record<string, AudioBuffer | null>>): void;
  unlock(): Promise<void>;
  toggleMute(): boolean;
  play(name: SoundName, options?: PlayOptions): void;
}

// Owns the AudioContext. Plays decoded AudioBuffers with zero latency and unlimited overlap.
// Rule of the platform: a context created before a user gesture starts "suspended";
// it can only be resumed from inside a click/keydown handler — see unlock().
export function createAudio(): Audio {
  const ctx = 'AudioContext' in window ? new AudioContext() : null;
  const buffers = new Map<string, AudioBuffer>();
  let master: GainNode | null = null;
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
      if (!ctx || !master || !buffer || ctx.state !== 'running') return; // missing sound = silence, not a crash
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
 * Subscribes the audio module to simulation events — the sim never imports this file.
 * `events` is the typed Bus<GameEvents> of a World (offline) or a NetGame (online).
 */
export function attachAudio(
  events: Bus<GameEvents>,
  width: number,
  audio: Audio,
  { signal }: { signal?: AbortSignalLike } = {},
): void {
  const panOf = (x: number) => (x / width) * 2 - 1;
  const opts = signal ? { signal } : {};

  events.on(
    'fired',
    ({ x, fast }) =>
      audio.play(fast ? 'shoot_fast' : 'shoot', {
        volume: 0.35,
        pan: panOf(x),
        rate: 0.95 + Math.random() * 0.1,
      }),
    opts,
  );
  events.on(
    'hit',
    (e) => audio.play('hit', { volume: e.kind === 'ship' ? 0.8 : 0.4, pan: panOf(e.x) }),
    opts,
  );
  events.on(
    'exploded',
    (e) => {
      if (e.kind === 'ship') audio.play('explode_big', { volume: 1, pan: panOf(e.x) });
      else
        audio.play('explode', {
          volume: 0.4 + e.size * 0.2,
          pan: panOf(e.x),
          rate: 1.3 - e.size * 0.15,
        });
    },
    opts,
  );
  events.on('pickup', ({ x }) => audio.play('pickup', { volume: 0.7, pan: panOf(x) }), opts);
  events.on('respawned', ({ x }) => audio.play('respawn', { volume: 0.6, pan: panOf(x) }), opts);
}
