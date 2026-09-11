import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts'],
    },
  },
});
