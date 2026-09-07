import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright + Electron end-to-end config for AFK Control.
 *
 * Boots the real Electron desktop client against a Vite dev server so the
 * renderer, preload, IPC handlers, and main process are all live in the
 * same window the user gets from `pnpm start`. The fake-afk CLI on PATH
 * (see `tests/e2e/_helpers/launch.ts`) intercepts subprocess calls so the
 * tests don't require real GitHub / GitLab credentials.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/_helpers/**", "**/fixtures/**"],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "electron", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    // The renderer source lives in this worktree; never reuse a stale Vite
    // from a different checkout (e.g. the main repo) that happens to be
    // bound to 5174 — that would serve the wrong main.tsx.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});