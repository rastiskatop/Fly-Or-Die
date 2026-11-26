// Debug handles exposed on window in development (console experiments at the defense).
import type { NetGame } from './net/netgame.ts';
import type { Lobby } from './lobby/lobby.ts';

declare global {
  interface Window {
    net?: NetGame;
    lobby?: Lobby;
    game?: unknown;
    /** set by the duel recorder (duel.html) when the GIF is saved */
    duelDone?: boolean;
  }
}

export {};
