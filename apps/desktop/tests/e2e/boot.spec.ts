import { test, expect } from "./_helpers/launch.js";

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
    await expect(groups.nth(2).getByRole("button")).toHaveText([/代码仓库/, /执行环境/, /SSH 主机/]);
    await expect(groups.nth(3).getByRole("button")).toHaveText([/活动记录/]);
    await expect(primaryNav.locator(".nav-item .nav-item")).toHaveCount(0);
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(2);
  });

  test("keeps the settings entry in the sidebar bottom constant area", async ({ page }) => {
    // 设置 is a global entry: it lives in the bottom constant area, not in a
    // navigation group (PRD-2026-10-22-001).
    const entry = page.locator(".sidebar-bottom .settings-entry");
    await expect(entry).toBeVisible();
    await expect(page.locator(".primary-nav button", { hasText: "设置" })).toHaveCount(0);
    await expect(page.locator(".primary-nav .nav-item")).toHaveCount(8);

    // It hugs the bottom edge instead of trailing the last group.
    const geometry = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect();
      const entry = document.querySelector(".settings-entry")!.getBoundingClientRect();
      const groups = document.querySelector(".primary-nav")!.getBoundingClientRect();
      return { toBottom: sidebar.bottom - entry.bottom, belowGroups: entry.top >= groups.bottom };
    });
    expect(geometry.toBottom).toBeLessThanOrEqual(24);
    expect(geometry.belowGroups).toBe(true);

    await entry.click();
    await expect(entry).toHaveClass(/active/);
    await expect(entry).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".breadcrumb strong")).toHaveText("设置");
  });

  test("keeps the settings entry reachable in the collapsed icon rail", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 800 });
    const entry = page.locator(".sidebar-bottom .settings-entry");
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.locator(".breadcrumb strong")).toHaveText("设置");
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
