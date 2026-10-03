import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The pilot suite is the only one that can incur model usage. It is
    // opt-in and never part of the default run.
    exclude: ['**/node_modules/**', 'tests/pilot/**'],
    environment: 'node',
    globalSetup: ['tests/helpers/global-setup.ts'],
    // Harness tests create real git repos and real file locks on disk.
    // Serialise file-system heavy suites by default; individual suites that
    // deliberately exercise concurrency do so inside a single test process.
    // Multiple forks (Vitest's default) — `poolOptions.forks.singleFork: false`
    // was dropped when `poolOptions` was removed in Vitest 4.
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
