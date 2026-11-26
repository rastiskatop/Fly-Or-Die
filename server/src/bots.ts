// Server-side AI pilots (Lab 7, M4).
//
// A bot is driven exactly like a human: it joins the Room as a Player, the Match spawns its ship,
// and every tick it sends ONE input `{ seq, buttons }` through `match.pushInputs()` — the same
// door a WebSocket client's inputs come through. It sees only what clients see: the tick's
// snapshot (plain entity states), never the World's objects. So the server can't tell a bot from
// a human, and anything that works for bots (load, rate limits, ack/seq) works for players too.
import { randomUUID } from 'node:crypto';
import {
  BUTTON,
  type EntityState,
  type Input,
  type ShipState,
} from '@flyordie/shared/net/protocol.ts';
import { asSeq, type EntityId, type Seq } from '@flyordie/shared/ids.ts';
import { bounds } from '@flyordie/shared/sim/arena.ts';
import type { Room, Player } from './rooms.ts';
import type { Match, TickSnapshot } from './match.ts';

/** The match's input port: how ANY player — a WebSocket client or a bot — drives its ship. */
export interface InputSink {
  pushInputs(playerId: string, inputs: readonly Input[]): void;
}

/** Something that produces a player's inputs from what that player can see. */
export interface PlayerInput {
  readonly playerId: string;
  /** Called with every tick's snapshot (the same data a client receives). */
  onSnapshot(snapshot: TickSnapshot, myShip: EntityId | undefined): void;
}

export interface BotPersonality {
  /** How close a rock may get before the bot breaks off and evades (px). */
  readonly caution: number;
  /** Fires when the aim error is below this (rad): lower = more careful, fewer shots. */
  readonly trigger: number;
  /** Preferred distance to its target (px). */
  readonly range: number;
}

const TWO_PI = Math.PI * 2;
const wrapAngle = (a: number): number => a - TWO_PI * Math.round(a / TWO_PI);

/** Shortest offset on the wrapping arena (ships wrap; using it for rocks too is harmless). */
const wrapDx = (dx: number): number => dx - Math.round(dx / bounds.width) * bounds.width;
const wrapDy = (dy: number): number => dy - Math.round(dy / bounds.height) * bounds.height;

/** Turn toward `angle`; returns the LEFT/RIGHT bits and the remaining aim error. */
function steer(me: ShipState, angle: number): { buttons: number; error: number } {
  const error = wrapAngle(angle - me.angle);
  const buttons = error > 0.06 ? BUTTON.right : error < -0.06 ? BUTTON.left : 0;
  return { buttons, error };
}

/**
 * The brain: a pure function of what the bot sees → buttons. Priorities:
 *  1. EVADE  — a rock inside `caution` that is closing in: turn away from it and burn.
 *  2. CHASE  — the nearest enemy ship (alive, not spawn-protected), else the nearest rock.
 *  3. SHOOT  — when the aim error is under `trigger` and the target is in range.
 */
export function botDecide(
  me: ShipState | undefined,
  entities: readonly EntityState[],
  p: BotPersonality,
  t: number,
): number {
  if (!me || me.destroyed) return 0;

  // Lab 7 (server profile, 63 bots): this loop was the server's #1 self time — every bot scans
  // every entity, and it allocated an {dx, dy, d} object + a Math.hypot per pair (~9,000 per
  // tick). Now: plain locals, squared distances, one sqrt per decision.
  let threatD2 = Infinity;
  let threatDx = 0;
  let threatDy = 0;
  let enemyD2 = Infinity;
  let enemyDx = 0;
  let enemyDy = 0;
  let rockD2 = Infinity;
  let rockDx = 0;
  let rockDy = 0;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (!e || e.id === me.id) continue;
    if (e.kind !== 'asteroid' && !(e.kind === 'ship' && !e.destroyed && e.invulnerable === 0))
      continue;
    const dx = wrapDx(e.x - me.x);
    const dy = wrapDy(e.y - me.y);
    const d2 = dx * dx + dy * dy;
    if (e.kind === 'asteroid') {
      // Snapshots carry no rock velocity (clients don't need it), so "too close" is the threat.
      const reach = p.caution + e.size * 14; // gap < caution  ⇔  d < caution + rock radius
      if (d2 < reach * reach && d2 < threatD2) {
        threatD2 = d2;
        threatDx = dx;
        threatDy = dy;
      }
      if (d2 < rockD2) {
        rockD2 = d2;
        rockDx = dx;
        rockDy = dy;
      }
    } else if (d2 < enemyD2) {
      enemyD2 = d2;
      enemyDx = dx;
      enemyDy = dy;
    }
  }

  if (threatD2 < Infinity) {
    return steer(me, Math.atan2(-threatDy, -threatDx)).buttons | BUTTON.thrust;
  }

  const hasEnemy = enemyD2 < Infinity;
  if (!hasEnemy && rockD2 === Infinity)
    return t % 60 < 30 ? BUTTON.thrust | BUTTON.left : BUTTON.thrust; // patrol
  const tdx = hasEnemy ? enemyDx : rockDx;
  const tdy = hasEnemy ? enemyDy : rockDy;
  const d = Math.sqrt(hasEnemy ? enemyD2 : rockD2);
  const { buttons, error } = steer(me, Math.atan2(tdy, tdx));
  let out = buttons;
  if (d > p.range || t % 50 < 6) out |= BUTTON.thrust;
  if (Math.abs(error) < p.trigger && d < 650) out |= BUTTON.fire;
  return out;
}

const NAMES = [
  'Hawk',
  'Viper',
  'Falcon',
  'Raven',
  'Kestrel',
  'Osprey',
  'Harrier',
  'Condor',
  'Merlin',
  'Swift',
];

export class Bot implements PlayerInput {
  readonly player: Player;
  readonly personality: BotPersonality;
  #seq = 0;
  #t = 0;
  readonly #sink: InputSink;

  constructor(sink: InputSink, index: number, rng: () => number = Math.random) {
    this.#sink = sink;
    this.player = {
      id: `bot-${randomUUID().slice(0, 6)}`,
      name: `BOT ${NAMES[index % NAMES.length] ?? 'Bot'}`,
      joinedAt: Date.now(),
    };
    this.personality = {
      caution: 70 + rng() * 80,
      trigger: 0.12 + rng() * 0.15,
      range: 160 + rng() * 160,
    };
  }

  get playerId(): string {
    return this.player.id;
  }

  get seq(): Seq {
    return asSeq(this.#seq);
  }

  onSnapshot(snapshot: TickSnapshot, myShip: EntityId | undefined): void {
    const me = snapshot.entities.find((e): e is ShipState => e.kind === 'ship' && e.id === myShip);
    const buttons = botDecide(me, snapshot.entities, this.personality, this.#t++);
    this.#sink.pushInputs(this.playerId, [{ seq: asSeq(++this.#seq), buttons }]);
  }
}

/**
 * Bots per room. Bots are room members like anyone else (they take slots and show in the roster);
 * when the last HUMAN leaves, the bots leave too — otherwise the match would run forever.
 */
export class BotManager {
  readonly #bots = new Map<string, Map<string, Bot>>(); // roomId → playerId → bot
  readonly #unsubscribe = new Map<string, () => void>();

  /** Sets the number of bots in `room` (adds or removes), within the room's free slots. Returns the count. */
  setCount(room: Room, match: () => Match | undefined, count: number): number {
    const bots = this.#bots.get(room.id) ?? new Map<string, Bot>();
    this.#bots.set(room.id, bots);
    while (bots.size > count) {
      const [id] = bots.keys();
      if (id === undefined) break;
      bots.delete(id);
      room.leave(id, 'bot removed');
    }
    // The sink looks the match up on every call: a room's match is replaced when it restarts.
    const sink: InputSink = { pushInputs: (id, inputs) => match()?.pushInputs(id, inputs) };
    while (bots.size < count && !room.full) {
      const bot = new Bot(sink, bots.size);
      bots.set(bot.playerId, bot);
      room.join(bot.player); // → the match starts if needed and spawns the bot's ship
    }
    if (bots.size > 0) this.#watch(room, match);
    return bots.size;
  }

  count(roomId: string): number {
    return this.#bots.get(roomId)?.size ?? 0;
  }

  isBot(playerId: string): boolean {
    for (const bots of this.#bots.values()) if (bots.has(playerId)) return true;
    return false;
  }

  /** Feed the room's bots every snapshot; drop them when no humans are left. */
  #watch(room: Room, match: () => Match | undefined): void {
    if (this.#unsubscribe.has(room.id)) return;
    const m = match();
    if (!m) return;
    const onSnapshot = (snap: TickSnapshot): void => {
      for (const bot of this.#bots.get(room.id)?.values() ?? [])
        bot.onSnapshot(snap, room.players.get(bot.playerId)?.shipId);
    };
    const onLeave = (): void => {
      const bots = this.#bots.get(room.id);
      if (!bots?.size) return;
      const humans = [...room.players.keys()].filter((id) => !bots.has(id));
      if (humans.length === 0) this.setCount(room, match, 0);
    };
    m.on('snapshot', onSnapshot);
    room.on('leave', onLeave);
    const stop = (): void => {
      m.off('snapshot', onSnapshot);
      room.off('leave', onLeave);
      room.off('matchEnd', stop);
      this.#unsubscribe.delete(room.id);
      this.#bots.delete(room.id);
    };
    room.on('matchEnd', stop);
    this.#unsubscribe.set(room.id, stop);
  }
}
