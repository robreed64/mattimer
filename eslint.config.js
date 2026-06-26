const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'dist/', '.partykit/', '.flatpak-builder/', 'public/supabase.js', 'public/partysocket.js'] },
  js.configs.recommended,
  {
    files: ['api/**/*.js', 'lib/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
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
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        PartySocket: 'readonly', // vendored partysocket.js
        QRCode: 'readonly',      // qrcodejs CDN script
        roundProgress: 'readonly', // public/js/progress.js
      },
    },
    rules: {
      // Top-level functions and catch bindings are referenced from HTML
      // onclick= attributes and legacy patterns static analysis can't see.
      'no-unused-vars': 'off',
    },
  },
];
