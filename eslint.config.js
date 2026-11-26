import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/', '**/node_modules/', 'server/logs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended, // includes no-explicit-any: zero `any` is enforced, not hoped for
  {
    files: ['client/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['server/**/*.ts', 'client/vite.config.ts', 'client/tools/**/*.ts', 'scripts/**/*.mjs', '*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['shared/**/*.ts'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  prettier,
);
