import { test, expect } from "./_helpers/launch";

test.describe("BacklogPage list", () => {
  test.beforeEach(async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
  });

  test("renders the three fixture rows with localized state and execution mode", async ({ page }) => {
    await expect(page.locator(".backlog-page")).toBeVisible();

    await expect(page.getByRole("heading", { name: "Provider Backlog" })).toBeVisible();

    const rows = page.locator(".backlog-row");
    await expect(rows).toHaveCount(3);

    await expect(rows.nth(0)).toContainText("登录态切换");
    await expect(rows.nth(0)).toContainText("待处理");
    await expect(rows.nth(0)).toContainText("AFK 自动");

    await expect(rows.nth(1)).toContainText("kg 演示");
    await expect(rows.nth(1)).toContainText("进行中");
    await expect(rows.nth(1)).toContainText("AFK 自动");

    await expect(rows.nth(2)).toContainText("支付回调");
    await expect(rows.nth(2)).toContainText("已完成");
    await expect(rows.nth(2)).toContainText("HITL 人工");
  });

  test("shows the platform selector defaulting to auto", async ({ page }) => {
    const platformSelect = page.getByLabel("选择 Provider");
    await expect(platformSelect).toBeVisible();
    await expect(platformSelect).toHaveValue("auto");
  });

  test("filters rows by query string", async ({ page }) => {
    const search = page.getByLabel("搜索 Backlog");
    await search.fill("kg");
    await expect(page.locator(".backlog-row")).toHaveCount(1);
    await expect(page.locator(".backlog-row").first()).toContainText("kg 演示");
  });

  test("filters rows by state via the state select", async ({ page }) => {
    await page.getByLabel("筛选状态").selectOption("done");
    await expect(page.locator(".backlog-row")).toHaveCount(1);
    await expect(page.locator(".backlog-row").first()).toContainText("支付回调");
  });
});