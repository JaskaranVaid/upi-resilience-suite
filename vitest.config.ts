import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
    // First use of PGlite in a file boots WASM Postgres and runs migrations.
    hookTimeout: 60_000,
    // Each worker boots its own PGlite (a large WASM Postgres). One per core starves boots past the
    // hook timeout on a throttled laptop, and eight at once exhausted V8 memory on a 16 GB machine
    // ("Fatal process out of memory: Zone", exit 0x80000003). Half the cores, at most four.
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  },
});
