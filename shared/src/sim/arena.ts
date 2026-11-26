import { z } from 'zod';

// Fixed logical arena size. The simulation must not depend on the browser window:
// every client and the server agree on the same arena.
export const bounds = Object.freeze({ width: 1280, height: 720 });

/**
 * Arena rules, as they come from client/public/assets/arenas/*.json — read by BOTH the client
 * (asset loader) and the server (at startup). One schema: runtime validation of the file AND
 * the static type. Missing fields fall back to defaults, unknown fields are dropped.
 */
export const ArenaSchema = z.object({
  id: z.string().default('default'),
  name: z.string().default('Default'),
  seed: z.number().int().default(2026),
  asteroidMass: z.number().min(0).max(50).default(4), // "big-asteroid equivalents" kept on the field
  initialAsteroids: z.number().int().min(0).max(50).default(3),
  seekerChance: z.number().min(0).max(1).default(0.3),
  pickupEvery: z.number().positive().default(9), // s
  maxPickups: z.number().int().min(0).max(20).default(2),
  terrain: z.enum(['grass', 'desert', 'snow']).default('grass'), // render-only
});

export type ArenaRules = z.infer<typeof ArenaSchema>;

/** Used when an arena file is missing or corrupt (Lab 3 failure gallery: the game still starts). */
export const DEFAULT_ARENA: ArenaRules = Object.freeze(ArenaSchema.parse({}));
