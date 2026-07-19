import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    hookTimeout: 60000,
    testTimeout: 60000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
});
