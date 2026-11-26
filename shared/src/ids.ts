import { z } from 'zod';

// Branded numbers: an EntityId, a Tick and a Seq are all `number` at runtime, but the compiler
// keeps them apart — passing a tick where an entity id is expected is a type error.
// The brand comes from zod, so the schemas check the value inside JSON messages and give the
// static type.
//
// The constructors below are TYPE GUARDS with the same checks as the schemas (integer, range).
// Lab 7: they used to call Schema.parse(), a full zod parse (context objects, issue arrays…) for
// every id of every entity in every decoded snapshot — measured among the top allocators.
// A guard narrows `number` to the branded type through a real runtime test, so still no `as`.

export const EntityIdSchema = z.number().int().min(1).max(0xffff).brand<'EntityId'>();
export type EntityId = z.infer<typeof EntityIdSchema>;

export const TickSchema = z.number().int().min(0).max(0xffffffff).brand<'Tick'>();
export type Tick = z.infer<typeof TickSchema>;

export const SeqSchema = z.number().int().min(0).max(0xffffffff).brand<'Seq'>();
export type Seq = z.infer<typeof SeqSchema>;

export const isEntityId = (n: number): n is EntityId =>
  Number.isInteger(n) && n >= 1 && n <= 0xffff;
export const isTick = (n: number): n is Tick => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
export const isSeq = (n: number): n is Seq => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

export function asEntityId(n: number): EntityId {
  if (isEntityId(n)) return n;
  throw new RangeError(`bad entity id ${n}`);
}
export function asTick(n: number): Tick {
  if (isTick(n)) return n;
  throw new RangeError(`bad tick ${n}`);
}
export function asSeq(n: number): Seq {
  if (isSeq(n)) return n;
  throw new RangeError(`bad seq ${n}`);
}
