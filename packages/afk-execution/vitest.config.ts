import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    // The runtime registry is a file under the user's home. Point it
    // somewhere disposable for the whole run, so no test can write into
    // the developer's machine by forgetting to.
    setupFiles: ['../../tests/setup-runtime-registry.ts'],
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
    // The root suite gives every test thirty seconds; a package must not
    // give the same test five. Several of these tests drive real git
    // repositories — bare remotes, clones, commits, worktrees — and a
    // loaded machine can push a legitimate repository operation past five
    // seconds. The ceiling only applies when a test actually hangs.
    //
    // The setup and teardown of those tests take just as long as the tests
    // do — creating a repository, cloning it, removing it — so the hook
    // gets the same ceiling. A test that times out inside its own setup is
    // still a test that timed out.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
  },
});
