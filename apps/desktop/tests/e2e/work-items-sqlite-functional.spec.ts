import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { navButton } from "./_helpers/nav.js";

const rendererUrl = `http://localhost:${process.env.AFK_E2E_PORT ?? "5174"}`;
const fixtureDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const electronEntry = path.join(fixtureDirectory, "electron.cjs");

async function launch(environment: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [electronEntry, `--user-data-dir=${environment.AFK_E2E_USER_DATA}`],
    env: environment,
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".primary-nav").getByRole("button", { name: "工作项" }).waitFor();
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}

test("reads repositories and work items from SQLite after remote inventory is unavailable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "afk-work-item-sqlite-e2e-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const userData = path.join(root, "electron-data");
  const store = path.join(root, "runtime-store.json");
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
    AFK_E2E_STORE: store,
    AFK_E2E_INVENTORY_CALLS: calls,
    AFK_E2E_USER_DATA: userData,
  };

  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(environment));
    const firstPage = await app.firstWindow();
    await navButton(firstPage, "代码仓库").click();
    await expect(firstPage.locator(".repository-list .row-item")).toHaveCount(2);
    await expect(firstPage.locator(".repository-list")).toContainText("acme/api");
    await expect(firstPage.locator(".repository-list")).toContainText("acme/web");
    await navButton(firstPage, "工作项").click();
    const firstRows = firstPage.locator(".backlog-row.work-item-row");
    await expect(firstRows).toHaveCount(2);
    await expect(firstRows.nth(0)).toContainText("API 登录态切换");
    await expect(firstRows.nth(1)).toContainText("Web 登录页调整");
    await app.close();
    app = undefined;

    const inventoryDirectory = path.join(home, ".afk", "storage", "inventory");
    expect(existsSync(inventoryDirectory)).toBe(true);
    expect(readdirSync(inventoryDirectory).some(file => file.endsWith(".sqlite"))).toBe(true);
    expect(readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);

    const offlineEnvironment = { ...environment, AFK_E2E_FAIL_INVENTORY: "1" };
    ({ app } = await launch(offlineEnvironment));
    const secondPage = await app.firstWindow();
    await navButton(secondPage, "代码仓库").click();
    await expect(secondPage.locator(".repository-list .row-item")).toHaveCount(2);
    await expect(secondPage.locator(".repository-list")).toContainText("acme/api");
    await expect(secondPage.locator(".repository-list")).toContainText("acme/web");

    await navButton(secondPage, "工作项").click();
    const rows = secondPage.locator(".backlog-row.work-item-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("API 登录态切换");
    await expect(rows.nth(1)).toContainText("Web 登录页调整");

    await secondPage.getByRole("button", { name: "筛选工作项" }).click();
    await secondPage.getByLabel("选择仓库").click();
    await secondPage.getByLabel("搜索 Issue 来源").fill("web");
    await secondPage.getByRole("option", { name: "acme/web" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Web 登录页调整");
    expect(readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
