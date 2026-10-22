import { test, expect } from "./_helpers/launch.js";
import { seedSelectionInventory } from "./_helpers/inventory.js";
import { IPC_CHANNELS } from "../../shared/ipc-contract.js";
import { INVENTORY } from "./fixtures/provider-inventory.mjs";

test.describe("global work items", () => {
  test.beforeEach(async ({ electronApp, page }) => { await seedSelectionInventory(electronApp, page); });
  test("shows same-number issues from different repositories without selecting a directory", async ({ page }) => {
    const rows = page.locator(".backlog-row.work-item-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator(".work-item-source-summary").getByLabel("GitHub")).toBeVisible();
    await expect(rows.nth(0).locator(".work-item-source-summary")).not.toContainText("GitHub Issue");
    await expect(rows.nth(0)).toContainText("acme/api");
    await expect(rows.nth(1)).toContainText("acme/web");
    await expect(rows.nth(0)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("待导入");
    const sourceReference = rows.nth(0).locator(".work-item-source-summary > span:not(.work-item-platform-icon)");
    expect(await sourceReference.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  test("filters the global inventory by project", async ({ page }) => {
    await page.getByRole("button", { name: "筛选工作项" }).click();
    const providerTrigger = page.getByLabel("选择 Provider");
    const projectTrigger = page.getByLabel("选择仓库");
    await expect(providerTrigger).toHaveCSS("white-space", "normal");
    await expect(providerTrigger.locator(".select-menu-trigger-value")).toHaveCSS("white-space", "nowrap");
    await expect(projectTrigger.locator(".select-menu-trigger-value")).toHaveCSS("white-space", "nowrap");

    await projectTrigger.click();
    const sourceSearch = page.getByLabel("搜索 Issue 来源");
    await expect(sourceSearch).toBeVisible();
    await expect(page.locator(".select-menu-options")).toHaveCSS("overflow-y", "auto");
    await sourceSearch.fill("web");
    await expect(page.getByRole("option", { name: "全部 Issue 来源" })).toBeVisible();
    await expect(page.getByRole("option", { name: "acme/api" })).toHaveCount(0);
    await page.getByRole("option", { name: "acme/web" }).click();
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(1);
    await expect(page.locator(".backlog-row.work-item-row")).toContainText("Web 登录页调整");
  });

  test("business tags stay distinct and wrap within the row in both themes", async ({ electronApp, page }) => {
    const tags = ["desktop-observability validation", "frontend", "validation-".repeat(16)];
    const inventory = structuredClone(INVENTORY);
    inventory.items[0].tags = tags;
    inventory.items[1].tags = [];
    await electronApp.evaluate(({ ipcMain }, { channel, inventory }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => inventory);
    }, { channel: IPC_CHANNELS.workItemsList, inventory });
    for (const theme of ["浅色", "深色"]) {
      await page.locator(".primary-nav").getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("radiogroup", { name: "界面主题" }).getByText(theme).click();
      await page.locator(".primary-nav").getByRole("button", { name: "工作项", exact: true }).click();
      await page.getByRole("button", { name: "刷新工作项" }).click();
      const rows = page.locator(".work-item-row");
      const labels = rows.first().getByRole("list", { name: "工作项标签" });
      await expect(labels.getByRole("listitem")).toHaveCount(3);
      await expect(rows.nth(1).getByRole("list", { name: "工作项标签" })).toHaveCount(0);
      for (const [width, height] of [[1440, 920], [800, 800]]) {
        await electronApp.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]);
        }, [width, height]);
        const label = labels.getByRole("listitem").first();
        await expect(label).toHaveCSS("border-top-left-radius", "2px");
        await expect(label.locator("svg")).toBeVisible();
        await expect(label).toHaveAttribute("title", tags[0]);
        await expect.poll(() => labels.evaluate(element =>
          [...element.querySelectorAll("li")].every(tag => tag.scrollWidth <= tag.clientWidth)
          && element.getBoundingClientRect().top >= element.previousElementSibling!.getBoundingClientRect().bottom
          && document.documentElement.scrollWidth <= window.innerWidth,
        )).toBe(true);
        if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/work-item-tags-${theme}-${width}.png`, animations: "disabled" });
      }
    }
  });
});
