import { readFileSync } from "node:fs";
import { test, expect, FAKE_AFK_STORE } from "./_helpers/launch";

type FakeStore = {
  items: Array<{ id: string; state: string; executionMode: string }>;
  history?: Array<{ backlogId: string; state: string; phase?: string }>;
};

function readStore(): FakeStore {
  return JSON.parse(readFileSync(FAKE_AFK_STORE, "utf8")) as FakeStore;
}

test("runs a root backlog through implementation, QA, merge confirmation, and done", async ({ page }) => {
  await page.locator(".primary-nav button", { hasText: "Backlog" }).click();

  const initialRow = page.locator(".backlog-row", { hasText: "登录态切换" });
  await initialRow.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByLabel("确认执行 Backlog 1")).toBeVisible();
  await page.getByRole("button", { name: "启动 Backlog 1" }).click();

  await expect.poll(() => readStore().items.find((item) => item.id === "1")).toMatchObject({
    state: "merge_ready",
    executionMode: "hitl",
  });
  expect(readStore().history).toEqual(expect.arrayContaining([
    { backlogId: "1", state: "in_progress", phase: "implementing" },
    { backlogId: "1", state: "verification", phase: "verifying" },
    { backlogId: "1", state: "merge_ready", phase: "verifying" },
  ]));

  await page.locator(".primary-nav button", { hasText: "工作流" }).click();
  await expect(page.locator(".workflow-library")).toBeVisible();
  await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
  const mergeReadyRow = page.locator(".backlog-row", { hasText: "登录态切换" });
  await expect(mergeReadyRow).toContainText("待合并");
  await mergeReadyRow.getByRole("button", { name: "确认合并" }).click();

  await expect(mergeReadyRow).toContainText("已完成");
  await expect(mergeReadyRow.getByRole("button", { name: "查看结果" })).toBeVisible();
  await mergeReadyRow.getByRole("button", { name: "查看结果" }).click();

  const drawer = page.getByRole("dialog", { name: "登录态切换" });
  await expect(drawer.locator('[aria-label="Provider 状态"]')).toContainText("已完成");
  await expect(drawer.locator('[aria-label="执行状态"]')).toContainText("已完成");
  await expect(drawer.locator('[aria-label="本地进程"]')).toContainText("已退出（成功）");
});
