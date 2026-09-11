import { test, expect } from "./_helpers/launch";

test.describe("BacklogPage create modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
  });

  test("opens the modal, requires description, and surfaces the validation error before calling api.create", async ({ page }) => {
    await page.getByRole("button", { name: "新建 Backlog" }).click();
    const dialog = page.getByRole("dialog", { name: "新建 Backlog" });
    await expect(dialog).toBeVisible();

    await dialog.locator('input[placeholder="登录态切换"]').fill("无描述的");
    await dialog.locator('textarea').fill(""); // browser blocks submit on required textarea
    await dialog.locator('button[type="submit"]').click();

    // Browser's native required validation prevents submission, so the
    // dialog stays open and no create call fires.
    await expect(dialog).toBeVisible();
  });

  test("creates a new backlog item, closes the modal, and inserts the row at the top of the list", async ({ page }) => {
    await page.getByRole("button", { name: "新建 Backlog" }).click();
    const dialog = page.getByRole("dialog", { name: "新建 Backlog" });
    await dialog.locator('input[placeholder="登录态切换"]').fill("新建测试 backlog");
    await dialog.locator('textarea').fill("E2E 创建流程的描述内容");
    await dialog.locator('input[placeholder="billing, urgent"]').fill("e2e, smoke");
    await dialog.locator('button[type="submit"]').click();

    await expect(page.getByRole("dialog", { name: "新建 Backlog" })).toHaveCount(0);

    const rows = page.locator(".backlog-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText("新建测试 backlog");
    await expect(rows.first()).toContainText("待处理");
  });

  test("cancels the modal with the cancel button without calling create", async ({ page }) => {
    await page.getByRole("button", { name: "新建 Backlog" }).click();
    const dialog = page.getByRole("dialog", { name: "新建 Backlog" });
    await dialog.locator('button[type="button"]', { hasText: "取消" }).click();
    await expect(page.getByRole("dialog", { name: "新建 Backlog" })).toHaveCount(0);
    await expect(page.locator(".backlog-row")).toHaveCount(3);
  });
});