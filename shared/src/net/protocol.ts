// Real-time protocol shared by client and server: constants, inputs, and the snapshot model.
// The snapshot model is defined ONCE as zod schemas; the TypeScript types are inferred from them,
// and the same schemas validate JSON snapshots at runtime (codec-json.ts).
import { z } from 'zod';
import { EntityIdSchema, SeqSchema, TickSchema, type Seq } from '../ids.ts';
import type { GameEvent } from '../sim/events.ts';
import type { World } from '../sim/world.ts';
import type { Controls } from '../sim/ship.ts';
import { PICKUP_EFFECTS } from '../sim/pickup.ts';

export const TICK_RATE = 30; // server simulation + snapshot rate, Hz
export const DT = 1 / TICK_RATE; // one input = one fixed step of DT, on client AND server
export const INPUT_REDUNDANCY = 3; // every input packet repeats the last N inputs (survives drops)
export const MAX_INPUT_QUEUE = 8; // server: inputs buffered per player beyond this are dropped

// ---------- inputs ----------
export const BUTTON = Object.freeze({ left: 1, right: 2, thrust: 4, fire: 8 });

export const ButtonsSchema = z.number().int().min(0).max(15);
export const InputSchema = z.object({
  seq: SeqSchema.refine((n) => n > 0, 'seq must be > 0'),
  buttons: ButtonsSchema,
});
export type Input = Readonly<z.infer<typeof InputSchema>>;

export function controlsToButtons(c: Controls): number {
  return (
    (c.left ? BUTTON.left : 0) |
    (c.right ? BUTTON.right : 0) |
    (c.thrust ? BUTTON.thrust : 0) |
    (c.fire ? BUTTON.fire : 0)
  );
}

export function buttonsToControls(b: number): Controls {
  return {
    left: (b & BUTTON.left) !== 0,
    right: (b & BUTTON.right) !== 0,
    thrust: (b & BUTTON.thrust) !== 0,
    fire: (b & BUTTON.fire) !== 0,
  };
}

// ---------- snapshot model: one schema → runtime check + static type ----------
const Common = { id: EntityIdSchema, x: z.number(), y: z.number(), angle: z.number() };

export const ShipStateSchema = z.object({
  kind: z.literal('ship'),
  ...Common,
  vx: z.number(),
  vy: z.number(),
  hp: z.number().min(0).max(255),
  score: z.number().int().min(0),
  deaths: z.number().int().min(0),
  destroyed: z.boolean(),
  thrusting: z.boolean(),
  hitFlash: z.boolean(),
  speed: z.number().min(0), // seconds of 'speed' effect left
  bullets: z.number().min(0),
  invulnerable: z.number().min(0),
  respawnIn: z.number().min(0),
  fireCooldown: z.number().min(0),
});
export const BulletStateSchema = z.object({
  kind: z.literal('bullet'),
  ...Common,
  vx: z.number(),
  vy: z.number(),
  owner: EntityIdSchema,
  spawnSeq: SeqSchema,
  fast: z.boolean(),
});
export const AsteroidStateSchema = z.object({
  kind: z.literal('asteroid'),
  ...Common,
  size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  seeker: z.boolean(),
  hitFlash: z.boolean(),
});
export const PickupStateSchema = z.object({
  kind: z.literal('pickup'),
  ...Common,
  effect: z.enum(PICKUP_EFFECTS),
  lifeLeft: z.number().min(0),
});
export const EntityStateSchema = z.discriminatedUnion('kind', [
  ShipStateSchema,
  BulletStateSchema,
  AsteroidStateSchema,
  PickupStateSchema,
]);

export type ShipState = Readonly<z.infer<typeof ShipStateSchema>>;
export type BulletState = Readonly<z.infer<typeof BulletStateSchema>>;
export type AsteroidState = Readonly<z.infer<typeof AsteroidStateSchema>>;
export type PickupState = Readonly<z.infer<typeof PickupStateSchema>>;
export type EntityState = ShipState | BulletState | AsteroidState | PickupState;
export type EntityStateKind = EntityState['kind'];

const at = { x: z.number(), y: z.number() };
/** Events as data. Annotated with the hand-written GameEvent type: if the two ever disagree, tsc fails. */
export const GameEventSchema: z.ZodType<GameEvent> = z.union([
  z.object({ type: z.literal('fired'), ...at, shipId: EntityIdSchema, fast: z.boolean() }),
  z.object({
    type: z.literal('hit'),
    ...at,
    kind: z.literal('ship'),
    id: EntityIdSchema,
    damage: z.number(),
  }),
  z.object({ type: z.literal('hit'), ...at, kind: z.literal('asteroid'), id: EntityIdSchema }),
  z.object({ type: z.literal('exploded'), ...at, kind: z.literal('ship'), shipId: EntityIdSchema }),
  z.object({
    type: z.literal('exploded'),
    ...at,
    kind: z.literal('asteroid'),
    size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.object({ type: z.literal('scored'), ...at, shipId: EntityIdSchema, points: z.number() }),
  z.object({
    type: z.literal('pickup'),
    ...at,
    shipId: EntityIdSchema,
    effect: z.enum(PICKUP_EFFECTS),
  }),
  z.object({ type: z.literal('respawned'), ...at, shipId: EntityIdSchema }),
]);

export const SnapshotSchema = z.object({
  tick: TickSchema,
  ack: SeqSchema,
  entities: z.array(EntityStateSchema),
  events: z.array(GameEventSchema),
});
export interface Snapshot {
  readonly tick: z.infer<typeof TickSchema>;
  readonly ack: Seq;
  readonly entities: readonly EntityState[];
  readonly events: readonly GameEvent[];
}

/** Plain-data view of the world — what a snapshot carries. Full precision; codecs quantize. */
export function snapshotEntities(world: World): EntityState[] {
  const out: EntityState[] = [];
  for (const e of world) {
    if (!e.alive) continue;
    const base = { id: e.id, x: e.pos.x, y: e.pos.y, angle: e.angle };
    switch (e.kind) {
      case 'ship':
        out.push({
          kind: 'ship',
          ...base,
          vx: e.vel.x,
          vy: e.vel.y,
          hp: e.hp,
          score: e.score,
          deaths: e.deaths,
          destroyed: e.destroyed,
          thrusting: e.thrusting,
          hitFlash: e.hitFlash > 0,
          speed: e.effects.get('speed') ?? 0,
          bullets: e.effects.get('bullets') ?? 0,
          invulnerable: e.invulnerableFor,
          respawnIn: Math.max(0, e.respawnIn),
          fireCooldown: e.fireCooldown,
        });
        break;
      case 'bullet':
        out.push({
          kind: 'bullet',
          ...base,
          vx: e.vel.x,
          vy: e.vel.y,
          owner: e.ownerId,
          spawnSeq: e.spawnSeq,
          fast: e.fast,
        });
        break;
      case 'asteroid':
        out.push({
          kind: 'asteroid',
          ...base,
          size: e.size,
          seeker: e.homing !== null,
          hitFlash: e.hitFlash > 0,
        });
        break;
      case 'pickup':
        if (e.pickup)
          out.push({
            kind: 'pickup',
            ...base,
            effect: e.pickup.effect,
            lifeLeft: Math.max(0, e.lifetime - e.age),
          });
        break;
      case 'explosion':
        break; // not sent: clients make their own from 'exploded' events
      default: {
        const unreachable: never = e; // a new entity kind must be handled here
        return unreachable;
      }
    }
  }
  return out;
}

/** Subscribes to every world event and collects them (in order) into the returned array. */
export function collectEvents(world: World): GameEvent[] {
  const events: GameEvent[] = [];
  const bus = world.events;
  // One line per event: the compiler checks each payload against its name. (A generic loop
  // over GAME_EVENT_NAMES can't prove that `type` and `payload` belong together.)
  bus.on('fired', (e) => events.push({ type: 'fired', ...e }));
  bus.on('hit', (e) => events.push({ type: 'hit', ...e }));
  bus.on('exploded', (e) => events.push({ type: 'exploded', ...e }));
  bus.on('scored', (e) => events.push({ type: 'scored', ...e }));
  bus.on('pickup', (e) => events.push({ type: 'pickup', ...e }));
  bus.on('respawned', (e) => events.push({ type: 'respawned', ...e }));
  return events;
}
