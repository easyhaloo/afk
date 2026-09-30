# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: backlog-create.spec.ts >> BacklogPage create modal >> creates a new backlog item, closes the modal, and inserts the row at the top of the list
- Location: tests/e2e/backlog-create.spec.ts:22:7

# Error details

```
Error: locator.click: Target page, context or browser has been closed
Call log:
  - waiting for locator('.primary-nav button').filter({ hasText: 'Backlog' })
    - locator resolved to <button class="nav-item" title="本地 Backlog">…</button>
  - attempting click action
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling
  - element was detached from the DOM, retrying

```

# Test source

```ts
  1  | import { test, expect } from "./_helpers/launch";
  2  | 
  3  | test.describe("BacklogPage create modal", () => {
  4  |   test.beforeEach(async ({ page }) => {
> 5  |     await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
     |                                                                       ^ Error: locator.click: Target page, context or browser has been closed
  6  |   });
  7  | 
  8  |   test("opens the modal, requires description, and surfaces the validation error before calling api.create", async ({ page }) => {
  9  |     await page.getByRole("button", { name: "新建 Backlog" }).click();
  10 |     const dialog = page.getByRole("dialog", { name: "新建 Backlog" });
  11 |     await expect(dialog).toBeVisible();
  12 | 
  13 |     await dialog.locator('input[placeholder="登录态切换"]').fill("无描述的");
  14 |     await dialog.locator('textarea').fill(""); // browser blocks submit on required textarea
  15 |     await dialog.locator('button[type="submit"]').click();
  16 | 
  17 |     // Browser's native required validation prevents submission, so the
  18 |     // dialog stays open and no create call fires.
  19 |     await expect(dialog).toBeVisible();
  20 |   });
  21 | 
  22 |   test("creates a new backlog item, closes the modal, and inserts the row at the top of the list", async ({ page }) => {
  23 |     await page.getByRole("button", { name: "新建 Backlog" }).click();
  24 |     const dialog = page.getByRole("dialog", { name: "新建 Backlog" });
  25 |     await dialog.locator('input[placeholder="登录态切换"]').fill("新建测试 backlog");
  26 |     await dialog.locator('textarea').fill("E2E 创建流程的描述内容");
  27 |     await dialog.locator('input[placeholder="billing, urgent"]').fill("e2e, smoke");
  28 |     await dialog.locator('button[type="submit"]').click();
  29 | 
  30 |     await expect(page.getByRole("dialog", { name: "新建 Backlog" })).toHaveCount(0);
  31 | 
  32 |     const rows = page.locator(".backlog-row");
  33 |     await expect(rows).toHaveCount(4);
  34 |     // Verify the newly created item appears as a backlog row with the expected content.
  35 |     const newRow = rows.filter({ hasText: "新建测试 backlog" });
  36 |     await expect(newRow).toContainText("新建测试 backlog");
  37 |     await expect(newRow).toContainText("待处理");
  38 |   });
  39 | 
  40 |   test("cancels the modal with the cancel button without calling create", async ({ page }) => {
  41 |     await page.getByRole("button", { name: "新建 Backlog" }).click();
  42 |     const dialog = page.getByRole("dialog", { name: "新建 Backlog" });
  43 |     await dialog.locator('button[type="button"]', { hasText: "取消" }).click();
  44 |     await expect(page.getByRole("dialog", { name: "新建 Backlog" })).toHaveCount(0);
  45 |     await expect(page.locator(".backlog-row")).toHaveCount(3);
  46 |   });
  47 | });
```