import { test, expect } from "./_helpers/launch";

test.describe("AFK Control boot", () => {
  test("boots into global work items with a single-level grouped navigation", async ({ page }) => {
    const primaryNav = page.locator(".primary-nav");
    await expect(primaryNav).toBeVisible();

    const groups = primaryNav.locator(".nav-group");
    await expect(groups).toHaveCount(4);
    await expect(groups.nth(0)).toHaveAttribute("aria-label", "Work");
    await expect(groups.nth(1)).toHaveAttribute("aria-label", "Automation");
    await expect(groups.nth(2)).toHaveAttribute("aria-label", "Resources");
    await expect(groups.nth(3)).toHaveAttribute("aria-label", "System");
    await expect(groups.nth(0).getByRole("button")).toHaveText([/工作项/, /运行中心/]);
    await expect(groups.nth(1).getByRole("button")).toHaveText([/工作流/, /Agents?/]);
    await expect(groups.nth(2).getByRole("button")).toHaveText([/代码仓库/, /执行环境/, /SSH 主机/, /本地 Backlog/]);
    await expect(groups.nth(3).getByRole("button")).toHaveText([/活动记录/, /设置/]);
    await expect(primaryNav.getByRole("button", { name: /项目 Backlog/ })).toHaveCount(0);
    await expect(primaryNav.locator(".nav-item .nav-item")).toHaveCount(0);
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(2);
  });

  test("keeps the run center available from the primary navigation", async ({ page }) => {
    const runCenter = page.locator(".primary-nav").getByRole("button", { name: /运行中心/ });
    await expect(runCenter).toBeVisible();
    await runCenter.click();

    await expect(runCenter).toHaveClass(/active/);
    await expect(page.getByLabel("运行视图切换")).toBeVisible();
    await expect(page.locator(".breadcrumb strong")).toHaveText("运行中心");
  });
});
