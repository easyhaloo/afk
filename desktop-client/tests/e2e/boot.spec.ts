import { test, expect } from "./_helpers/launch";

test.describe("AFK Control boot", () => {
  test("boots, renders the primary nav, and exposes the Backlog entry", async ({ page }) => {
    const primaryNav = page.locator(".primary-nav");
    await expect(primaryNav).toBeVisible();

    const backlogNav = page.locator(".primary-nav button", { hasText: "Backlog" });
    await expect(backlogNav).toBeVisible();
    await expect(backlogNav).toBeEnabled();

    // Each primary nav entry is a <button> directly inside .primary-nav.
    await expect(page.locator(".primary-nav > button")).toHaveCount(7);
  });
});