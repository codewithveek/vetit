import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: { reporter: ['text', 'lcov'], include: ['packages/*/src/**/*.ts'] },
  },
});
