// ============================================================
// Playwright Config for API Workflow Tests
// ============================================================
// Copy this to your project's e2e/api-workflow/playwright.config.ts
//
// IMPORTANT: Adjust testDir based on where you place this file:
//   - If in project root (tests/api-workflow/): './'
//   - If in frontend/e2e/api-workflow/: '.' (current dir)
// ============================================================

import { defineConfig } from '@playwright/test';

export default defineConfig({
  // IMPORTANT: Set to '.' (current directory) if config is inside e2e/ folder
  // Otherwise Playwright won't find the .spec.ts files
  testDir: '.',

  // Disable parallel execution for stable API tests
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,

  reporter: 'list',
  timeout: 60000,

  use: {
    // Default to localhost:8080 for local development
    // Override with BASE_URL env var for different environments
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      // API key should be set via WIKI_API_KEY env var, not hardcoded
      ...(process.env.WIKI_API_KEY && { 'X-API-Key': process.env.WIKI_API_KEY }),
    },
  },

  projects: [
    {
      name: 'api',
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
