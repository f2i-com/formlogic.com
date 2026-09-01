import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Sandboxed custom-screen SOURCES (shipped as customScreen.files, bundled by esbuild-wasm on
    // Preact inside an iframe): no Vite fast-refresh and no React compiler apply to them, so those
    // app-oriented rules are noise here. Core correctness rules stay on.
    files: [
      'src/data/packs/*/screens/**/*.{ts,tsx}',
      'src/lib/screen-kit/**/*.{ts,tsx}',
      // Pack-internal parity module (components + helpers in one tested file; not HMR'd app code).
      'src/data/packs/aokie-receptionist/receptionistVoice.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      // The codebase already uses a leading underscore to mean "declared on
      // purpose, deliberately unused" — 55 parameters say so, most of them
      // positional placeholders in callbacks and test shims where the argument
      // cannot simply be dropped. Honour that convention instead of leaving the
      // marker decorative; without it the rule fires on exactly the parameters
      // whose name already documents the intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
])
