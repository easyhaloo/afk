/**
 * Shared Playwright fixture that boots the real AFK Control Electron
 * application with the `fake-afk` CLI on PATH. Each spec receives an
 * `electronApp` and a `page` whose renderer is the production React tree
 * served from the running Vite dev server.
 *
 * The webServer block in `playwright.config.ts` already starts Vite on
 * port 5174. We pass `ELECTRON_RENDERER_URL` so the main process loads
 * that URL instead of the packaged `dist/index.html`, which keeps the
 * tests running against the current source without a rebuild cycle.
 */
import { test as base, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = __dirname;
export const FIXTURE_DIR = path.resolve(HERE, "../fixtures");
export const FAKE_AFK = path.join(FIXTURE_DIR, "afk");
export const RENDERER_URL = "http://localhost:5174";
// fake-afk persists its in-memory store here so writes from one subprocess
// invocation survive into the next. Reset to "{}" between specs for isolation.
export const FAKE_AFK_STORE = path.join(tmpdir(), "afk-backlog-e2e-store.json");

function resetStore() {
  // Delete the file so the next fake-afk invocation re-seeds itself.
  if (existsSync(FAKE_AFK_STORE)) rmSync(FAKE_AFK_STORE);
}

export type Fixtures = {
  electronApp: ElectronApplication;
  page: Page;
};

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    resetStore();
    const app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: RENDERER_URL,
        // Prepend the fixture dir so the fake-afk script wins `which afk`.
        PATH: `${FIXTURE_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_AFK_STORE,
        // Surface fake-afk stderr in the Playwright runner output for debugging.
        FAKE_AFK_DEBUG: process.env.FAKE_AFK_DEBUG ?? "0",
      },
      timeout: 30_000,
    });
    if (process.env.FAKE_AFK_DEBUG === "1") {
      app.process().stderr?.on("data", (chunk) => process.stderr.write(`[electron stderr] ${chunk}`));
    }
    await use(app);
    await app.close();
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

export const expect = test.expect;