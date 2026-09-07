import { test, expect } from "./_helpers/launch";

test.describe("SshPage search filter", () => {
  test.beforeEach(async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();
  });

  test("typing into the search box keeps the empty-state visible and is stable across keystrokes", async ({ page }) => {
    const search = page.getByLabel("搜索 SSH 主机");
    await expect(search).toBeVisible();

    await search.fill("staging");
    await expect(page.locator(".ssh-empty")).toBeVisible();
    await expect(page.locator(".ssh-empty")).toContainText("没有匹配的 SSH 主机");

    await search.fill("");
    await expect(page.locator(".ssh-empty")).toBeVisible();
  });

  test("refresh button re-issues the SSH list without crashing on an empty home", async ({ page }) => {
    const refresh = page.getByLabel("刷新 SSH 主机");
    await expect(refresh).toBeVisible();
    await refresh.click();
    await expect(page.locator(".ssh-empty")).toBeVisible();
  });
});