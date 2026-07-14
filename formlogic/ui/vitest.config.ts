import { defineConfig } from 'vitest/config';

// Frontend unit-test runner (review item 26). Standalone config (not extending vite.config) so pure
// TS-logic tests run fast without the PWA/React plugin chain. Component tests can opt into a DOM with a
// per-file `// @vitest-environment jsdom` pragma once @testing-library is added.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
