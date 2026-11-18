import { configDefaults, defineConfig } from 'vitest/config';
import { resolveE2eRuntime } from './tests/e2e/installed-runtime.js';

// ponytail: node-pty 1.1.0 fires its ThreadSafeFunction callback during
// node::Environment::CleanupHandles; the C++ exception then has no JS stack to
// unwind into and calls std::__terminate, aborting the entire vitest worker.
// `pool: 'forks'` contains that abort to one child process. Tests that need a
// real terminal live in tests/pty/ and are opt-in via `pnpm test:e2e:pty`
// (vitest.pty.config.ts) — drop new ones there, no config edit needed.
export default defineConfig({
  test: {
    environment: 'node',
    ...(process.env.AFK_E2E_CLI_ENTRY !== undefined && { env: {
      AFK_E2E_RUNTIME_ROOT: resolveE2eRuntime(process.env.AFK_E2E_CLI_ENTRY, process.env.AFK_E2E_RUNTIME_ROOT).runtime,
    } }),
    setupFiles: ['scripts/test-home.ts'],
    testTimeout: 30000,
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/pty/**'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts'],
    },
  },
});
