import { test, expect } from "./_helpers/launch";

test.describe("AFK Control boot", () => {
  test("boots into global work items and keeps the project backlog available", async ({ page }) => {
    const primaryNav = page.locator(".primary-nav");
    await expect(primaryNav).toBeVisible();

    await expect(page.locator(".primary-nav button", { hasText: "工作项" })).toBeVisible();
    await expect(page.locator(".primary-nav button", { hasText: "项目 Backlog" })).toBeVisible();
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(2);

    // Each primary nav entry is a <button> directly inside .primary-nav.
    await expect(page.locator(".primary-nav > button")).toHaveCount(8);
  });
});
