import { EventEmitter } from 'node:events';
import { createMatchWorld, spawnPlayerShip } from '@flyordie/shared/sim/game.js';
import { bounds } from '@flyordie/shared/sim/arena.js';
import { NO_CONTROLS } from '@flyordie/shared/sim/ship.js';
import {
  TICK_RATE,
  DT,
  MAX_INPUT_QUEUE,
  buttonsToControls,
  isValidInput,
  snapshotEntities,
  collectEvents,
} from '@flyordie/shared/net/protocol.js';

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
export class Match extends EventEmitter {
  #timer = null;
  #nextAt = 0;
  #events;

  constructor({ roomId, arena }) {
    super();
    this.roomId = roomId;
    this.world = createMatchWorld({ ...bounds, arena });
    this.#events = collectEvents(this.world);
    this.players = new Map(); // playerId -> { shipId, queue, lastSeq, lastQueuedSeq, controls }
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

  get tick() {
    return this.world.tick;
  }

  addPlayer(playerId, name) {
    const ship = spawnPlayerShip(this.world, name);
    this.players.set(playerId, {
      shipId: ship.id,
      queue: [],
      lastSeq: 0,
      lastQueuedSeq: 0,
      controls: NO_CONTROLS,
    });
    return ship.id;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.world.despawn(p.shipId);
    this.players.delete(playerId);
  }

  ackFor(playerId) {
    return this.players.get(playerId)?.lastSeq ?? 0;
  }

  /** Validated, de-duplicated (redundant copies), ordered by seq, bounded. */
  pushInputs(playerId, inputs) {
    const p = this.players.get(playerId);
    if (!p) return;
    for (const input of [...inputs].sort((a, b) => a.seq - b.seq)) {
      if (!isValidInput(input) || input.seq <= p.lastQueuedSeq) continue; // old / duplicate / garbage
      p.queue.push(input);
      p.lastQueuedSeq = input.seq;
    }
    if (p.queue.length > MAX_INPUT_QUEUE) {
      // A client sending faster than real time (or a burst after a stall): keep the newest.
      this.stats.droppedInputs += p.queue.length - MAX_INPUT_QUEUE;
      p.queue.splice(0, p.queue.length - MAX_INPUT_QUEUE);
    }
  }

  step() {
    const controls = new Map();
    for (const p of this.players.values()) {
      const input = p.queue.shift();
      if (input) {
        p.controls = buttonsToControls(input.buttons);
        p.lastSeq = input.seq;
      } else {
        this.stats.starved++;
      }
      const ship = this.world.get(p.shipId);
      if (ship) ship.inputSeq = p.lastSeq;
      controls.set(p.shipId, p.controls);
    }
    this.#events.length = 0;
    this.world.step(DT, controls);
    this.emit('snapshot', {
      tick: this.world.tick,
      entities: snapshotEntities(this.world),
      events: [...this.#events],
    });
  }

  start() {
    this.#nextAt = performance.now() + INTERVAL_MS;
    this.#schedule();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule() {
    this.#timer = setTimeout(() => this.#run(), Math.max(0, this.#nextAt - performance.now()));
  }

  #run() {
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

  statsJSON() {
    const round = (n) => Math.round(n * 100) / 100;
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
