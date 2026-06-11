const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'dist/', '.partykit/', '.flatpak-builder/', 'public/supabase.js', 'public/partysocket.js'] },
  js.configs.recommended,
  {
    files: ['api/**/*.js', 'lib/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['api/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node, Request: 'readonly', Response: 'readonly' },
    },
  },
  {
    files: ['party/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.worker },
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
