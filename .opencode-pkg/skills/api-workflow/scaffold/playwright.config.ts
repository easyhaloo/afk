// Playwright configuration for generated API workflow tests.
// Set AUTH_MODE=storage-state only after the generated setup file implements
// the target application's real login flow. The default is API-only mode.

import { defineConfig } from '@playwright/test';
import path from 'node:path';

const authMode = process.env.AUTH_MODE ?? 'api';
const authStateFile = path.resolve(
  process.env.AUTH_STATE_FILE ?? 'playwright/.auth/user.json',
);

if (!['api', 'storage-state'].includes(authMode)) {
  throw new Error(
    `Unsupported AUTH_MODE "${authMode}". Use "api" or "storage-state".`,
  );
}

const projects =
  authMode === 'storage-state'
    ? [
        {
          name: 'setup',
          testMatch: /.*\.setup\.ts/,
        },
        {
          name: 'api',
          testMatch: /.*\.spec\.ts/,
          dependencies: ['setup'],
          use: { storageState: authStateFile },
        },
      ]
    : [
        {
          name: 'api',
          testMatch: /.*\.spec\.ts/,
        },
      ];

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      ...(process.env.API_KEY && {
        [process.env.API_KEY_HEADER || 'X-API-Key']: process.env.API_KEY,
      }),
    },
  },
  projects,
});
