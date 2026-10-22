import { test, expect } from "./_helpers/launch.js";

test.describe("Select close behavior", () => {
  test("ssh source filter popover closes after option click", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();
    await page.getByRole("button", { name: "筛选 SSH 主机" }).click();
    await page.getByLabel("来源筛选").click();
    const popover = page.getByRole("listbox", { name: "来源筛选" });
    await expect(popover).toBeVisible();
    await page.getByRole("option", { name: "AFK 管理" }).click();
    await expect(popover).toHaveCount(0);
  });

  test("ssh status filter popover closes after option click", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();
    await page.getByRole("button", { name: "筛选 SSH 主机" }).click();
    await page.getByLabel("状态筛选").click();
    const popover = page.getByRole("listbox", { name: "状态筛选" });
    await expect(popover).toBeVisible();
    await page.getByRole("option", { name: "可连接" }).click();
    await expect(popover).toHaveCount(0);
  });
});
