import { test, expect } from "./_helpers/launch";
import { seedSelectionInventory } from "./_helpers/inventory";

test.describe("global work items", () => {
  test.beforeEach(async ({ electronApp, page }) => { await seedSelectionInventory(electronApp, page); });
  test("shows same-number issues from different repositories without selecting a directory", async ({ page }) => {
    const rows = page.locator(".backlog-row.work-item-row");
    await expect(rows).toHaveCount(3);
    // Default sort is updatedAt:desc — Web (Oct 2026) first, then API (Jan 2026), then early (Jun 2025)
    await expect(rows.nth(0).locator(".work-item-source-summary").getByLabel("GitHub")).toBeVisible();
    await expect(rows.nth(0).locator(".work-item-source-summary")).not.toContainText("GitHub Issue");
    await expect(rows.nth(0)).toContainText("acme/web");
    await expect(rows.nth(1)).toContainText("acme/api");
    await expect(rows.nth(0)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("#1");
    await expect(rows.nth(0)).toContainText("待导入");
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

  test("sort selector reverses row order and persists across filter and load-more", async ({ page }) => {
    const rows = page.locator(".backlog-row.work-item-row");
    // Default desc: newest first (Web Oct > API Jan > Early Jun)
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Web 登录页调整");
    await expect(rows.nth(1)).toContainText("API 登录态切换");

    // Open sort selector and switch to asc
    const sortTrigger = page.getByRole("button", { name: "排序" });
    await sortTrigger.click();
    await page.getByRole("option", { name: "最早更新优先" }).click();

    // Asc: oldest first (Early Jun < API Jan < Web Oct)
    await expect(rows.nth(0)).toContainText("早期 API 调整");
    await expect(rows.nth(1)).toContainText("API 登录态切换");
    await expect(rows.nth(2)).toContainText("Web 登录页调整");

    // Sort persists after applying project filter
    await page.getByRole("button", { name: "筛选工作项" }).click();
    await page.getByLabel("选择仓库").click();
    await page.getByRole("option", { name: "acme/api" }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("早期 API 调整");
    await expect(rows.nth(1)).toContainText("API 登录态切换");
  });

  test("sort selector keyboard and accessibility", async ({ page }) => {
    const sortTrigger = page.getByRole("button", { name: "排序" });
    await sortTrigger.click();
    // Popover should be visible
    await expect(page.getByRole("listbox")).toBeVisible();
    // Escape closes and returns focus to trigger
    await sortTrigger.press("Escape");
    await expect(page.getByRole("listbox")).not.toBeVisible();
    // Clicking a row still works after sort interaction
    const rows = page.locator(".backlog-row.work-item-row");
    await rows.first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
