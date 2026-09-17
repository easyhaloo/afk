import { test, expect } from "./_helpers/launch";

test.describe("Select close behavior", () => {
  test("backlog provider popover closes after option click and outside click", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
    const platform = page.getByRole("button", { name: "选择 Provider" });
    await platform.click();
    const popover = page.getByRole("listbox", { name: "选择 Provider" });
    await expect(popover).toBeVisible();
    await page.getByRole("option", { name: "GitHub" }).click();
    await expect(popover).toHaveCount(0);

    await platform.click();
    await expect(popover).toBeVisible();
    await page.locator(".backlog-heading > div").first().click();
    await expect(popover).toHaveCount(0);
  });

  test("backlog state popover closes after option click", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
    await page.getByLabel("筛选状态").click();
    const popover = page.getByRole("listbox", { name: "筛选状态" });
    await expect(popover).toBeVisible();
    await page.getByRole("option", { name: "已完成" }).click();
    await expect(popover).toHaveCount(0);
  });

  test("backlog create modal: execution mode popover closes after option click", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
    await page.getByRole("button", { name: "新建 Backlog" }).click();
    const mode = page.getByLabel("执行模式");
    await mode.click();
    const popover = page.getByRole("listbox", { name: "执行模式" });
    await expect(popover).toBeVisible();
    await page.getByRole("option", { name: "HITL 人工" }).click();
    await expect(popover).toHaveCount(0);
  });

  test("ssh source filter popover closes after option click", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();
    await page.getByLabel("来源筛选").click();
    const popover = page.getByRole("listbox", { name: "来源筛选" });
    await expect(popover).toBeVisible();
    await page.getByRole("option", { name: "AFK 管理" }).click();
    await expect(popover).toHaveCount(0);
  });

  test("ssh status filter popover closes after option click", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();
    await page.getByLabel("状态筛选").click();
    const popover = page.getByRole("listbox", { name: "状态筛选" });
    await expect(popover).toBeVisible();
    await page.getByRole("option", { name: "可连接" }).click();
    await expect(popover).toHaveCount(0);
  });
});
