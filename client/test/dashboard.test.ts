import { expect, test } from 'vitest';
import { parseMetrics, sum, byLabel } from '../src/metrics-text.ts';

const TEXT = [
  '# HELP flyordie_players Players in rooms',
  '# TYPE flyordie_players gauge',
  'flyordie_players{service="flyordie"} 12',
  'flyordie_tick_p99_ms{room="eu-1",service="flyordie"} 4.62',
  'flyordie_tick_p99_ms{room="eu-2",service="flyordie"} 6.8',
  'flyordie_ws_rejections_total{reason="ip_cap",service="flyordie"} 3',
  'flyordie_ws_rejections_total{reason="origin",service="flyordie"} 1',
  'flyordie_process_resident_memory_bytes{service="flyordie"} 9.01e+07',
  '',
].join('\n');

test('parseMetrics: names, labels (minus the service label), values; comments skipped', () => {
  const m = parseMetrics(TEXT);
  expect(m.get('flyordie_players')).toBe(12);
  expect(m.get('flyordie_tick_p99_ms{room="eu-1"}')).toBe(4.62);
  expect(m.get('flyordie_process_resident_memory_bytes')).toBe(9.01e7);
  expect(m.size).toBe(6);
});

test('sum over all series of a metric; byLabel picks one label', () => {
  const m = parseMetrics(TEXT);
  expect(sum(m, 'flyordie_ws_rejections_total')).toBe(4);
  expect([...byLabel(m, 'flyordie_tick_p99_ms', 'room')]).toEqual([
    ['eu-1', 4.62],
    ['eu-2', 6.8],
  ]);
});
