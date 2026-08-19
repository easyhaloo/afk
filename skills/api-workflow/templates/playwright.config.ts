import { defineConfig } from '@playwright/test';

// Adapt this scaffold to the target repository rather than copying it blindly.
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: process.env.BASE_URL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      ...(process.env.API_KEY && { 'X-API-Key': process.env.API_KEY }),
      ...(process.env.API_TOKEN && { Authorization: `Bearer ${process.env.API_TOKEN}` }),
    },
  },
  projects: [
    {
      name: 'api',
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
