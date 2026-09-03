import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite's builtin-module list predates node:sqlite; leave it to the Node 22+ runtime.
  ssr: { external: ['node:sqlite'] },
  test: {
    environment: 'node',
    testTimeout: 30000,
    // node-pty's native process lifecycle is not safe across concurrent test workers on Node 24.
    fileParallelism: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts'],
    },
  },
});
