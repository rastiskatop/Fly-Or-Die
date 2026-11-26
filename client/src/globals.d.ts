// Debug handles exposed on window in development (console experiments at the defense).
import type { NetGame } from './net/netgame.ts';
import type { Lobby } from './lobby/lobby.ts';
import type { perf } from './perf.ts';

declare global {
  interface Window {
    net?: NetGame;
    lobby?: Lobby;
    /** ?perf=1 only */
    perf?: typeof perf;
    game?: unknown;
    /** set by the duel recorder (duel.html) when the GIF is saved */
    duelDone?: boolean;
  }
}

export {};
