import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/', '**/dist-profile/', '**/node_modules/', 'server/logs/', 'coverage/', 'playwright-report/', 'test-results/'],
  },
  js.configs.recommended,
  // Type-CHECKED rules: they read the TypeScript program, so they can see a Promise nobody
  // awaits, `any` sneaking in through a library (JSON, events.once), …
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // Every tsconfig in the repo (projectService would only find files named tsconfig.json).
      parserOptions: {
        project: [
          './tsconfig.json',
          './shared/tsconfig.test.json',
          './client/tsconfig.json',
          './client/tsconfig.node.json',
          './server/tsconfig.json',
          './server/scripts/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['client/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['server/**/*.ts', 'client/vite.config.ts', 'client/tools/**/*.ts', 'scripts/**/*.ts', '*.js', '*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['client/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['shared/**/*.ts'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // A promise nobody awaits or .catch()es: its rejection is lost (or, in Node, kills the
      // process as an unhandledRejection). Intentional fire-and-forget must say `void p`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  // Plain JS (this file): no type information to check against.
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
