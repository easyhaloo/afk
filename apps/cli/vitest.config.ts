import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', testTimeout: 30000, pool: 'forks', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
