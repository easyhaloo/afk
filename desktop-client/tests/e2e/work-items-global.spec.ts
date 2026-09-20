import { test, expect } from "./_helpers/launch";

test.describe("global work items", () => {
  test("shows same-number issues from different repositories without selecting a directory", async ({ page }) => {
    const rows = page.locator(".backlog-row.work-item-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("acme/api");
    await expect(rows.nth(1)).toContainText("acme/web");
    await expect(rows.nth(0)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("普通 Issue");
  });

  test("filters the global inventory by project", async ({ page }) => {
    await page.getByLabel("选择仓库").click();
    await page.getByRole("option", { name: "acme/web" }).click();
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(1);
    await expect(page.locator(".backlog-row.work-item-row")).toContainText("Web 登录页调整");
  });
});
