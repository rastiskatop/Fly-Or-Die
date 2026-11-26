import { z } from 'zod';

// Branded numbers: an EntityId, a Tick and a Seq are all `number` at runtime, but the compiler
// keeps them apart — passing a tick where an entity id is expected is a type error.
// The brand comes from zod, so the SAME schema checks the value at runtime (binary decoder,
// JSON messages) and gives the static type. No `as` casts needed: parsing is the constructor.

export const EntityIdSchema = z.number().int().min(1).max(0xffff).brand<'EntityId'>();
export type EntityId = z.infer<typeof EntityIdSchema>;

export const TickSchema = z.number().int().min(0).max(0xffffffff).brand<'Tick'>();
export type Tick = z.infer<typeof TickSchema>;

export const SeqSchema = z.number().int().min(0).max(0xffffffff).brand<'Seq'>();
export type Seq = z.infer<typeof SeqSchema>;

export const asEntityId = (n: number): EntityId => EntityIdSchema.parse(n);
export const asTick = (n: number): Tick => TickSchema.parse(n);
export const asSeq = (n: number): Seq => SeqSchema.parse(n);
