import { EventEmitter } from 'node:events';
import type { World } from '@flyordie/shared/sim/world.ts';
import type { Controls } from '@flyordie/shared/sim/ship.ts';
import type { ArenaRules } from '@flyordie/shared/sim/arena.ts';
import type { GameEvent } from '@flyordie/shared/sim/events.ts';
import { asSeq, asTick, type EntityId, type Seq, type Tick } from '@flyordie/shared/ids.ts';
import { createMatchWorld, spawnPlayerShip } from '@flyordie/shared/sim/game.ts';
import { bounds } from '@flyordie/shared/sim/arena.ts';
import { NO_CONTROLS } from '@flyordie/shared/sim/ship.ts';
import {
  TICK_RATE,
  DT,
  MAX_INPUT_QUEUE,
  buttonsToControls,
  snapshotEntities,
  collectEvents,
  type EntityState,
  type Input,
} from '@flyordie/shared/net/protocol.ts';

interface PlayerSlot {
  readonly shipId: EntityId;
  readonly queue: Input[];
  lastSeq: Seq;
  lastQueuedSeq: number;
  controls: Controls;
}

/** What a tick produces; ws.ts adds each client's own `ack` before encoding. */
export interface TickSnapshot {
  readonly tick: Tick;
  readonly entities: readonly EntityState[];
  readonly events: readonly GameEvent[];
}

interface MatchEvents {
  snapshot: [snapshot: TickSnapshot];
}

interface MatchStats {
  ticks: number;
  durationAvgMs: number;
  durationMaxMs: number;
  jitterAvgMs: number;
  jitterMaxMs: number;
  overruns: number;
  starved: number;
  droppedInputs: number;
}

const INTERVAL_MS = 1000 / TICK_RATE;

/**
 * The authoritative simulation of one room. Emits 'snapshot' ({ tick, entities, events }) every tick.
 *
 * Inputs: every client input is ONE fixed step of DT. Each tick the server applies, per player,
 * exactly one input from that player's queue (the queue absorbs network jitter). If the queue is
 * empty the player's last controls are repeated (and their acked seq doesn't advance).
 *
 * Timing: not setInterval (drifts, coalesces). Each tick is scheduled against an ABSOLUTE target
 * time: nextAt += 33.33 ms; setTimeout(run, nextAt − now). Lateness is measured as jitter; a tick
 * that ends after the next one was due is an overrun and the schedule re-bases instead of bursting.
 */
export class Match extends EventEmitter<MatchEvents> {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #nextAt = 0;
  readonly #events: GameEvent[];
  readonly roomId: string;
  readonly world: World;
  readonly players = new Map<string, PlayerSlot>();
  readonly stats: MatchStats;

  constructor({ roomId, arena }: { roomId: string; arena: Partial<ArenaRules> }) {
    super();
    this.roomId = roomId;
    this.world = createMatchWorld({ ...bounds, arena });
    this.#events = collectEvents(this.world);
    this.stats = {
      ticks: 0,
      durationAvgMs: 0,
      durationMaxMs: 0,
      jitterAvgMs: 0,
      jitterMaxMs: 0,
      overruns: 0,
      starved: 0,
      droppedInputs: 0,
    };
  }

  get tick(): number {
    return this.world.tick;
  }

  addPlayer(playerId: string, name: string): EntityId {
    const ship = spawnPlayerShip(this.world, name);
    this.players.set(playerId, {
      shipId: ship.id,
      queue: [],
      lastSeq: asSeq(0),
      lastQueuedSeq: 0,
      controls: NO_CONTROLS,
    });
    return ship.id;
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    this.world.despawn(p.shipId);
    this.players.delete(playerId);
  }

  ackFor(playerId: string): Seq {
    return this.players.get(playerId)?.lastSeq ?? asSeq(0);
  }

  /** De-duplicated (redundant copies), ordered by seq, bounded. */
  pushInputs(playerId: string, inputs: readonly Input[]): void {
    const p = this.players.get(playerId);
    if (!p) return;
    for (const input of [...inputs].sort((a, b) => a.seq - b.seq)) {
      // Shape and ranges were already checked at the boundary (codec / zod) — here only order matters.
      if (input.seq <= p.lastQueuedSeq) continue; // old or a redundant duplicate
      p.queue.push(input);
      p.lastQueuedSeq = input.seq;
    }
    if (p.queue.length > MAX_INPUT_QUEUE) {
      // A client sending faster than real time (or a burst after a stall): keep the newest.
      this.stats.droppedInputs += p.queue.length - MAX_INPUT_QUEUE;
      p.queue.splice(0, p.queue.length - MAX_INPUT_QUEUE);
    }
  }

  step(): void {
    const controls = new Map<EntityId, Controls>();
    for (const p of this.players.values()) {
      const input = p.queue.shift();
      if (input) {
        p.controls = buttonsToControls(input.buttons);
        p.lastSeq = input.seq;
      } else {
        this.stats.starved++;
      }
      const ship = this.world.get(p.shipId);
      if (ship?.kind === 'ship') ship.inputSeq = p.lastSeq;
      controls.set(p.shipId, p.controls);
    }
    this.#events.length = 0;
    this.world.step(DT, controls);
    this.emit('snapshot', {
      tick: asTick(this.world.tick),
      entities: snapshotEntities(this.world),
      events: [...this.#events],
    });
  }

  start(): void {
    this.#nextAt = performance.now() + INTERVAL_MS;
    this.#schedule();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    this.#timer = setTimeout(() => this.#run(), Math.max(0, this.#nextAt - performance.now()));
  }

  #run(): void {
    const start = performance.now();
    const late = start - this.#nextAt;
    this.step();
    const duration = performance.now() - start;

    const s = this.stats;
    s.ticks++;
    const k = s.ticks < 100 ? 1 / s.ticks : 0.01; // running average, then exponential
    s.durationAvgMs += (duration - s.durationAvgMs) * k;
    s.durationMaxMs = Math.max(s.durationMaxMs, duration);
    s.jitterAvgMs += (Math.abs(late) - s.jitterAvgMs) * k;
    s.jitterMaxMs = Math.max(s.jitterMaxMs, late);

    this.#nextAt += INTERVAL_MS;
    const now = performance.now();
    if (now > this.#nextAt) {
      s.overruns++; // CPU-bound (Lab 7 problem): don't try to "catch up" with a burst of ticks
      this.#nextAt = now;
    }
    if (this.#timer !== null) this.#schedule();
  }

  statsJSON(): Record<string, number | string> {
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      room: this.roomId,
      tick: this.world.tick,
      tickRate: TICK_RATE,
      players: this.players.size,
      entities: this.world.size,
      ...Object.fromEntries(Object.entries(this.stats).map(([k, v]) => [k, round(v)])),
    };
  }
}
