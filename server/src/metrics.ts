// /metrics in the Prometheus text format (prom-client), Lab 8.
//
// Counters only ever grow (messages, bytes, rejections) — a dashboard derives "per second" with
// rate(). Gauges are read at scrape time (players, rooms, tick p99, event-loop utilization).
// prom-client's default metrics add process RSS, heap, GC pauses and event-loop lag for free.
import { performance } from 'node:perf_hooks';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export interface MetricsSources {
  readonly players: () => number;
  readonly rooms: () => number;
  readonly connections: () => number;
  /** p99 tick duration of every running match, ms. */
  readonly tickP99s: () => readonly { room: string; p99: number }[];
}

export function createMetrics(version: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'flyordie' });
  collectDefaultMetrics({ register: registry, prefix: 'flyordie_' });

  const messagesIn = new Counter({
    name: 'flyordie_ws_messages_in_total',
    help: 'WebSocket messages received, by message type',
    labelNames: ['type'] as const,
    registers: [registry],
  });
  const messagesOut = new Counter({
    name: 'flyordie_ws_messages_out_total',
    help: 'WebSocket messages sent',
    registers: [registry],
  });
  const bytesIn = new Counter({
    name: 'flyordie_ws_bytes_in_total',
    help: 'WebSocket bytes received',
    registers: [registry],
  });
  const bytesOut = new Counter({
    name: 'flyordie_ws_bytes_out_total',
    help: 'WebSocket bytes sent',
    registers: [registry],
  });
  const rejections = new Counter({
    name: 'flyordie_ws_rejections_total',
    help: 'Connections refused or closed by policy, by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  new Gauge({
    name: 'flyordie_build_info',
    help: 'Build version (git commit) of the running server',
    labelNames: ['version'] as const,
    registers: [registry],
  }).set({ version }, 1);

  /** Gauges that read live state when Prometheus (or the dashboard) scrapes. */
  function attach(src: MetricsSources): void {
    new Gauge({
      name: 'flyordie_players',
      help: 'Players in rooms (humans and bots)',
      registers: [registry],
      collect() {
        this.set(src.players());
      },
    });
    new Gauge({
      name: 'flyordie_rooms',
      help: 'Rooms that exist',
      registers: [registry],
      collect() {
        this.set(src.rooms());
      },
    });
    new Gauge({
      name: 'flyordie_ws_connections',
      help: 'Open WebSocket connections',
      registers: [registry],
      collect() {
        this.set(src.connections());
      },
    });
    new Gauge({
      name: 'flyordie_tick_p99_ms',
      help: 'p99 tick duration of each running match over the last 60 s (budget: 33.3 ms)',
      labelNames: ['room'] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const { room, p99 } of src.tickP99s()) this.set({ room }, p99);
      },
    });
    let last = performance.eventLoopUtilization();
    new Gauge({
      name: 'flyordie_event_loop_utilization',
      help: 'Share of time the event loop was busy since the previous scrape (0..1)',
      registers: [registry],
      collect() {
        const now = performance.eventLoopUtilization();
        this.set(performance.eventLoopUtilization(now, last).utilization);
        last = now;
      },
    });
  }

  return {
    registry,
    attach,
    messageIn(type: string, bytes: number): void {
      messagesIn.inc({ type });
      bytesIn.inc(bytes);
    },
    messageOut(bytes: number): void {
      messagesOut.inc();
      bytesOut.inc(bytes);
    },
    rejected(reason: string): void {
      rejections.inc({ reason });
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
