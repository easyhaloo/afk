import path from "node:path";
import { test as base, expect, E2E_HOME_PATH, FIXTURE_DIR, RENDERER_URL } from "./_helpers/launch";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Error path: launch a second Electron instance with FAKE_AFK_FAIL_LIST=1
 * so the fake-afk CLI returns a failure envelope for `backlog list`. The
 * BacklogPage surfaces this through its error banner.
 */
const crashTest = base.extend<{ crashApp: ElectronApplication; crashPage: Page }>({
  crashApp: async ({}, use) => {
    const app = await electron.launch({
      args: [".", `--user-data-dir=${path.join(E2E_HOME_PATH, "crash-electron-data")}`],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: RENDERER_URL,
        HOME: E2E_HOME_PATH,
        USERPROFILE: E2E_HOME_PATH,
        PATH: `${FIXTURE_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_AFK_FAIL_LIST: "1",
      },
      timeout: 30_000,
    });
    await use(app);
    await app.close();
  },
  crashPage: async ({ crashApp }, use) => {
    const page = await crashApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

crashTest("shows the page-level error banner when the list call returns a failure envelope", async ({ crashPage }) => {
  await crashPage.locator(".primary-nav button", { hasText: "Backlog" }).click();
  const alert = crashPage.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText("FAKE_AFK_FAIL_LIST");
});
