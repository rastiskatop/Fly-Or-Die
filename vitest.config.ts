// `npm test` at the root: Vitest runs the three packages as projects in one process tree.
// `npm run coverage`: the same, with V8 coverage; shared/ (the sim + protocol) must stay ≥ 85 %.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['shared', 'server', 'client'],
    coverage: {
      provider: 'v8',
      include: ['shared/src/**/*.ts', 'server/src/**/*.ts', 'client/src/**/*.ts'],
      reporter: ['text-summary', 'text', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        'shared/src/**/*.ts': { lines: 85, statements: 85, functions: 85, branches: 75 },
      },
    },
  },
});
