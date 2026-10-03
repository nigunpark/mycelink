import { defineConfig } from 'vitest/config';

/**
 * Pilot-only config.
 *
 * Separate from vitest.config.ts so the pilot can never be picked up by an
 * ordinary `vitest run`. It still requires MYCELINK_REAL_CLAUDE_PILOT=1 at
 * runtime, so running this config by accident is also harmless.
 */
export default defineConfig({
  test: {
    include: ['tests/pilot/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
  },
});
