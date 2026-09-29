import { readFileSync } from "node:fs";
import { test, expect, FAKE_AFK_STORE } from "./_helpers/launch";

test("Backlog opens the matching work item instead of starting its own runner", async ({ page }) => {
  await page.locator(".primary-nav button", { hasText: "Backlog" }).click();

  const row = page.locator(".backlog-row", { hasText: "登录态切换" });
  await row.getByRole("button", { name: "在工作项中执行" }).click();

  await expect(page.getByLabel("工作项 github:acme/api#1")).toBeVisible();
  await expect(page.getByLabel("工作项 github:acme/web#1")).toHaveCount(0);
  const store = JSON.parse(readFileSync(FAKE_AFK_STORE, "utf8")) as { history: unknown[] };
  expect(store.history).toEqual([]);
});
