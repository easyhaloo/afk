import { test, expect } from "./_helpers/launch";

test.describe("BacklogPage tag operations", () => {
  test.beforeEach(async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
  });

  test("removes a tag chip via its × button and refreshes the list", async ({ page }) => {
    const row = page.locator(".backlog-row").filter({ hasText: "登录态切换" });
    // The × button is hidden until the chip is hovered; force the click so
    // the test doesn't depend on CSS pointer-events behaviour.
    await row.locator('button[aria-label="移除标签 billing"]').click({ force: true });
    // After remove + force-refresh, the chip should be gone.
    await expect(row.locator(".backlog-tags li")).toHaveCount(0);
  });

  test("adds a tag via the inline form below each row", async ({ page }) => {
    const row = page.locator(".backlog-row").filter({ hasText: "支付回调" });
    const tagInput = row.getByLabel("为 支付回调 添加标签");
    await tagInput.fill("reviewed");
    await tagInput.press("Enter");

    await expect(row.locator(".backlog-tags li")).toContainText("reviewed");
  });
});