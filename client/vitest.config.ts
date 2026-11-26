// Client unit tests: pure logic only (loop accumulator, reconciliation, connection backoff).
// Everything that needs a real browser is in e2e/ (Playwright).
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'client',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
