import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // First use of PGlite in a file boots WASM Postgres and runs migrations.
    hookTimeout: 60_000,
  },
});
