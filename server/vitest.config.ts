import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests fork the real server and talk to it over sockets.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
