import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // The integration tests stand real servers up on real sockets and talk MCP
    // between them. On a loaded machine — or a cold CI runner, where the whole
    // suite spends thirty seconds in transform alone — the default five-second
    // timeout is short enough to fail a test that was going to pass. Headroom
    // here is not hiding a slow test; every one of these finishes in under a
    // second when the machine is idle.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: { reporter: ['text', 'lcov'], include: ['packages/*/src/**/*.ts'] },
  },
});
