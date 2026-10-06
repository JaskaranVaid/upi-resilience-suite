import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // First use of PGlite in a file boots WASM Postgres and runs migrations.
    hookTimeout: 60_000,
    // Each worker boots its own WASM Postgres; on a laptop on battery, one worker per core makes
    // those boots starve each other past the hook timeout. Half the cores is as fast and reliable.
    maxWorkers: '50%',
  },
});
