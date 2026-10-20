import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    // A forked child shares the parent's environment, so a test that stubs
    // HOME sees it through os.homedir(). A worker thread gets a copy of
    // process.env that never reaches the real environment, and node-pty
    // aborts the worker on cleanup — both reasons the root suite forks.
    pool: 'forks',
    // The root suite gives every test thirty seconds; a package must not
    // give the same test five. Several of these tests drive real git
    // repositories — bare remotes, clones, commits, worktrees — and a
    // loaded machine can push a legitimate repository operation past five
    // seconds. The ceiling only applies when a test actually hangs.
    testTimeout: 30000,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
  },
});
