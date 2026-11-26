import type { EntityId } from '../ids.ts';
import type { AsteroidSize } from './asteroid.ts';
import type { PickupEffect } from './pickup.ts';

interface At {
  readonly x: number;
  readonly y: number;
}

/** Everything the simulation announces. Event name → payload. */
export interface GameEvents {
  fired: At & { readonly shipId: EntityId; readonly fast: boolean };
  hit: At &
    (
      | { readonly kind: 'ship'; readonly id: EntityId; readonly damage: number }
      | { readonly kind: 'asteroid'; readonly id: EntityId }
    );
  exploded: At &
    (
      | { readonly kind: 'ship'; readonly shipId: EntityId }
      | { readonly kind: 'asteroid'; readonly size: AsteroidSize }
    );
  scored: At & { readonly shipId: EntityId; readonly points: number };
  pickup: At & { readonly shipId: EntityId; readonly effect: PickupEffect };
  respawned: At & { readonly shipId: EntityId };
}

export type GameEventName = 'fired' | 'hit' | 'exploded' | 'scored' | 'pickup' | 'respawned';
export const GAME_EVENT_NAMES = [
  'fired',
  'hit',
  'exploded',
  'scored',
  'pickup',
  'respawned',
] as const satisfies readonly GameEventName[];

/**
 * The same events as ONE discriminated union, for carrying them in snapshots:
 * { type: 'fired', shipId, fast, x, y } | { type: 'hit', kind: 'ship', … } | …
 * Built with a mapped type indexed by its own keys — add an event to GameEvents and
 * GameEvent (and every exhaustive switch over it) follows.
 */
export type GameEvent = {
  [K in GameEventName]: { readonly type: K } & GameEvents[K];
}[GameEventName];
