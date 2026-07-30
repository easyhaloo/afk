// ============================================================
// Playwright Config for API Workflow Tests
// ============================================================
// Copy this to your project's playwright.config.ts
// ============================================================

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/api-workflow',
  timeout: 60000,
  use: {
    baseURL: process.env.BASE_URL || 'https://api.example.com',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  },
  projects: [
    {
      name: 'api',
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
