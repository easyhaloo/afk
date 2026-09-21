import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rendererUrl = `http://localhost:${process.env.AFK_E2E_PORT ?? "5174"}`;
const fixtureDirectory = path.resolve(__dirname, "fixtures");
const fakeAfk = path.join(fixtureDirectory, "afk");
const inventoryDelayMs = 2_500;

type LaunchMeasurement = {
  app: ElectronApplication;
  launchMs: number;
  rowsVisibleMs: number;
};

async function launchAndMeasure(environment: NodeJS.ProcessEnv): Promise<LaunchMeasurement> {
  const launchStartedAt = performance.now();
  const app = await electron.launch({
    args: [".", `--user-data-dir=${environment.AFK_E2E_USER_DATA}`],
    env: environment,
    timeout: 30_000,
  });
  const launchMs = performance.now() - launchStartedAt;
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const rowsStartedAt = performance.now();
  await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(2);
  return { app, launchMs, rowsVisibleMs: performance.now() - rowsStartedAt };
}

test("loads the persisted work item model before a delayed remote synchronization", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "afk-work-item-cache-e2e-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const userData = path.join(root, "electron-data");
  const store = path.join(root, "fake-afk-store.json");
  const calls = path.join(root, "inventory-calls.log");
  mkdirSync(path.join(home, ".ssh"), { recursive: true });
  mkdirSync(path.join(workspace, ".afk"), { recursive: true });
  mkdirSync(userData, { recursive: true });

  const environment = {
    ...process.env,
    ELECTRON_RENDERER_URL: rendererUrl,
    HOME: home,
    USERPROFILE: home,
    AFK_WORKSPACE: workspace,
    PATH: `${fixtureDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    AFK_DESKTOP_CLI: fakeAfk,
    FAKE_AFK_STORE: store,
    FAKE_AFK_INVENTORY_DELAY_MS: String(inventoryDelayMs),
    FAKE_AFK_INVENTORY_CALLS: calls,
    AFK_E2E_USER_DATA: userData,
  };

  let cold: LaunchMeasurement | undefined;
  let warm: LaunchMeasurement | undefined;
  let coldLaunchMs = 0;
  let coldRowsVisibleMs = 0;
  try {
    cold = await launchAndMeasure(environment);
    coldLaunchMs = cold.launchMs;
    coldRowsVisibleMs = cold.rowsVisibleMs;
    await expect.poll(() => existsSync(path.join(userData, "work-item-inventory.json"))).toBe(true);
    await cold.app.close();
    cold = undefined;

    warm = await launchAndMeasure(environment);
    const page = await warm.app.firstWindow();
    const refresh = page.getByRole("button", { name: "刷新工作项" });
    const refreshStartedAt = performance.now();
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toBeEnabled({ timeout: inventoryDelayMs * 2 });
    const forcedRefreshMs = performance.now() - refreshStartedAt;
    const callCount = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length;

    console.log(JSON.stringify({
      inventoryDelayMs,
      coldLaunchMs: Math.round(coldLaunchMs),
      coldRowsVisibleMs: Math.round(coldRowsVisibleMs),
      warmLaunchMs: Math.round(warm.launchMs),
      warmRowsVisibleMs: Math.round(warm.rowsVisibleMs),
      forcedRefreshMs: Math.round(forcedRefreshMs),
      inventoryCallCount: callCount,
    }));

    expect(coldRowsVisibleMs).toBeGreaterThan(inventoryDelayMs / 2);
    expect(warm.rowsVisibleMs).toBeLessThan(inventoryDelayMs / 2);
    expect(warm.rowsVisibleMs).toBeLessThan(coldRowsVisibleMs / 2);
    expect(forcedRefreshMs).toBeGreaterThan(inventoryDelayMs / 2);
    expect(callCount).toBeGreaterThanOrEqual(2);
  } finally {
    await cold?.app.close().catch(() => undefined);
    await warm?.app.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
