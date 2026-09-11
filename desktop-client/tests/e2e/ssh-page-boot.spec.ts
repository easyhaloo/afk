import { test, expect } from "./_helpers/launch";

test.describe("SshPage boot", () => {
  test("clicking the SSH nav renders the page with the empty-state placeholder", async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();

    const sshPage = page.locator(".ssh-page");
    await expect(sshPage).toBeVisible();
    await expect(page.getByRole("heading", { name: "SSH 主机" })).toBeVisible();

    // With an empty scratch ~/.ssh the page should fall through to its
    // empty placeholder rather than failing on a missing config.
    const empty = page.locator(".ssh-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("没有匹配的 SSH 主机");
  });
});