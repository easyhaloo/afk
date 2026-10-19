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
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
  },
});
