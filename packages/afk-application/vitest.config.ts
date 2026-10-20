import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    // The root suite gives every test thirty seconds; a package must not
    // give the same test five. Several of these tests drive real git
    // repositories — bare remotes, clones, commits, worktrees — and a
    // loaded machine can push a legitimate repository operation past five
    // seconds. The ceiling only applies when a test actually hangs.
    testTimeout: 30000,
    include: ['tests/**/*.test.ts'],
  },
});
