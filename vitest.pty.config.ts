import { defineConfig } from 'vitest/config';

// Opt-in home for the real-terminal tests that vitest.config.ts excludes.
// They need a real PTY, a built dist/index.js, and (for notification) headless
// Chromium. `pool: 'forks'` carries over because the node-pty abort applies here
// too. Convention: anything in tests/pty/ needs a real terminal.
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    pool: 'forks',
    include: ['tests/pty/**/*.test.ts'],
  },
});
