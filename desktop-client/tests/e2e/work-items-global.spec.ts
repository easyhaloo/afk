import { test, expect } from "./_helpers/launch";

test.describe("global work items", () => {
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
});
