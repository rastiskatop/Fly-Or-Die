import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/dist/', '**/node_modules/', 'server/logs/'] },
  js.configs.recommended,
  {
    // Browser code
    files: ['client/src/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser },
  },
  {
    // Node code: the server, build config, asset generators, repo scripts
    files: [
      'server/**/*.js',
      'server/**/*.mjs',
      'client/vite.config.js',
      'client/tools/**/*.mjs',
      'scripts/**/*.mjs',
      '*.js',
    ],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
  },
  {
    // Shared simulation/protocol: runs in BOTH runtimes → only globals common to Node and browsers
    files: ['shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals['shared-node-browser'],
    },
  },
  prettier,
];
