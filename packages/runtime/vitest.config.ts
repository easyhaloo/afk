import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { target: 'node22' },
  test: { environment: 'node', testTimeout: 30000, pool: 'forks', setupFiles: ['../../scripts/test-home.ts'], include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
