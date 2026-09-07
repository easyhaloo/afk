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
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = __dirname;
export const FIXTURE_DIR = path.resolve(HERE, "../fixtures");
export const FAKE_AFK = path.join(FIXTURE_DIR, "afk");
export const RENDERER_URL = "http://localhost:5174";
// fake-afk persists its in-memory store here so writes from one subprocess
// invocation survive into the next. Delete before each test for isolation.
export const FAKE_AFK_STORE = path.join(tmpdir(), "afk-backlog-e2e-store.json");
// Per-spec scratch HOME so the SSH page sees a deterministic, empty
// ~/.ssh/config regardless of the developer's real environment.
export const E2E_HOME = path.join(tmpdir(), "afk-control-e2e-home");

function resetStore() {
  if (existsSync(FAKE_AFK_STORE)) rmSync(FAKE_AFK_STORE);
}

async function resetHome() {
  // The previous Electron child may still hold file handles on the
  // scratch dir for a moment after it exits; retry on EBUSY/ENOTEMPTY.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (existsSync(E2E_HOME)) rmSync(E2E_HOME, { recursive: true, force: true });
      mkdirSync(path.join(E2E_HOME, ".ssh"), { recursive: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

export type Fixtures = {
  electronApp: ElectronApplication;
  page: Page;
};

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    resetStore();
    await resetHome();
    const app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: RENDERER_URL,
        // Override HOME so SSH adapters read from our scratch directory
        // instead of the developer's real ~/.ssh/config.
        HOME: E2E_HOME,
        USERPROFILE: E2E_HOME,
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

// Helpers exported for SSH page specs.
export { E2E_HOME as E2E_HOME_PATH, resetHome, mkdirSync, chmodSync, writeFileSync };