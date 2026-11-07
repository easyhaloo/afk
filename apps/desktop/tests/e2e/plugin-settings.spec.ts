import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch.js";

test("manages a local plugin through Settings, preload, IPC and the real PluginManager", async ({ page, electronApp }, testInfo) => {
  const root = mkdtempSync(path.join(tmpdir(), "afk-desktop-plugin-e2e-"));
  const source = path.join(root, "source");
  const config = path.join(root, "config.json");
  const secret = "DESKTOP_E2E_SECRET_MUST_STAY_IN_MAIN";
  mkdirSync(path.join(source, "dist"), { recursive: true });
  writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "desktop-e2e-plugin", type: "module" }));
  writeFileSync(path.join(source, "plugin.json"), JSON.stringify({ id: "context.desktop-e2e", version: "1.0.0", apiVersion: 1, provides: ["surface.desktop"], trusted: true, configSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false } }));
  writeFileSync(path.join(source, "dist/index.js"), "throw new Error('Do not execute a new surface in the management UI');");
  writeFileSync(config, JSON.stringify({ token: secret }));
  try {
    await electronApp.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async options => ({ canceled: false, filePaths: [options.properties?.includes("openDirectory") ? files.source : files.config] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, { source, config });
    await page.locator(".sidebar-bottom .settings-entry").click();
    const settings = page.getByRole("region", { name: "插件管理" });
    await expect(settings.getByLabel("刷新插件列表")).toBeEnabled();
    await expect(settings.getByLabel("禁用 workflow.capabilities")).toBeVisible();
    await settings.getByLabel("禁用 workflow.capabilities").click();
    await expect(settings.getByLabel("启用 workflow.capabilities")).toBeEnabled();
    await settings.getByLabel("启用 workflow.capabilities").click();
    await expect(settings.getByLabel("禁用 workflow.capabilities")).toBeEnabled();
    await settings.getByRole("button", { name: "安装插件", exact: true }).click();
    await settings.getByRole("button", { name: "选择本地目录" }).click();
    const plugin = settings.locator(".plugin-list > li").filter({ hasText: "context.desktop-e2e" });
    await expect(plugin).toContainText("已安装");
    await expect(plugin).toContainText("检查快照：未加载");
    await plugin.getByLabel("导入 context.desktop-e2e 配置 JSON").click();
    await expect(settings.getByRole("status")).toContainText("已保存");
    await plugin.getByLabel("禁用 context.desktop-e2e").click();
    await expect(plugin.getByLabel("启用 context.desktop-e2e")).toBeEnabled();
    await plugin.getByLabel("启用 context.desktop-e2e").click();
    await expect(plugin.getByLabel("禁用 context.desktop-e2e")).toBeEnabled();
    expect(readFileSync(path.join(E2E_HOME_PATH, ".afk/plugins.yml"), "utf8")).toContain(secret);
    expect(await page.evaluate(() => JSON.stringify(window.afkDesktop ? document.body.textContent : "missing"))).not.toContain(secret);
    expect(await page.evaluate(async () => JSON.stringify(await window.afkDesktop.plugins.list()))).not.toContain(secret);

    const receipts = path.join(E2E_HOME_PATH, ".afk/workspaces/plugin-protection");
    mkdirSync(receipts, { recursive: true });
    writeFileSync(path.join(receipts, "work-item-runs.json"), JSON.stringify([{ status: "running", pid: process.pid }]));
    await plugin.getByLabel("卸载 context.desktop-e2e").click();
    await page.getByRole("button", { name: "确认卸载插件", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText("Worker");
    await expect(plugin).toBeVisible();
    rmSync(receipts, { recursive: true });
    await settings.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("plugin-settings.png"), fullPage: true });
    await testInfo.attach("plugin-settings", { path: testInfo.outputPath("plugin-settings.png"), contentType: "image/png" });
    await plugin.getByLabel("卸载 context.desktop-e2e").click();
    await page.getByRole("button", { name: "确认卸载插件", exact: true }).click();
    await expect(plugin).toContainText("仅配置记录");
    await expect(plugin.getByLabel("启用 context.desktop-e2e")).toBeDisabled();
    expect(readFileSync(path.join(E2E_HOME_PATH, ".afk/plugins.yml"), "utf8")).toContain(secret);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
