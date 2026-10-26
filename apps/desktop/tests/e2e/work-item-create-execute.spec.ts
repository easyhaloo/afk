import { test, expect, E2E_HOME_PATH } from "./_helpers/launch.js";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

test("creates a PRD-backed work item and executes it through Desktop", async ({ page }) => {
  const title = "建立基于 Transcript 唯一事实源的 AFK Retro 反馈闭环";
  const description = [
    "基于 docs/product/PRD-retro-feedback-loop.md 实现一次可追踪的 AFK 工作项执行。",
    "验收：Desktop 可创建工作项；可从工作项详情选择仓库与 main 分支启动执行；运行记录最终显示已完成。",
  ].join("\n\n");

  await page.getByRole("button", { name: "创建工作项" }).click();
  await page.getByRole("button", { name: "新建 Backlog" }).click();
  await expect(page.getByRole("dialog", { name: "新建 Backlog" })).toBeVisible();
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("描述").fill(description);
  await page.getByRole("dialog", { name: "新建 Backlog" }).getByRole("button", { name: "创建" }).click();

  const backlogRow = page.locator(".backlog-row", { hasText: title });
  await expect(backlogRow).toBeVisible();
  await backlogRow.getByRole("button", { name: "在工作项中执行" }).click();
  await page.getByRole("button", { name: "刷新工作项" }).click();

  const detail = page.getByRole("dialog", { name: /github:acme\/api#\d+/ });
  await expect(detail).toContainText(title);
  await detail.getByRole("button", { name: "开始执行" }).click();
  const setup = page.getByRole("dialog", { name: "开始执行工作项" });
  await expect(setup).toBeVisible();
  await setup.getByRole("button", { name: "创建运行" }).click();

  await expect(detail).toContainText("运行已创建", { timeout: 10_000 });
  await expect(detail).toContainText(/已完成|QA 待确认/, { timeout: 10_000 });
  const projectDirectory = path.join(E2E_HOME_PATH, ".loop-workspace/github/acme/api");
  const [issueNumber] = await readdir(projectDirectory);
  const workspaceRoot = path.join(projectDirectory, issueNumber);
  const workspaceHash = createHash("sha256").update(workspaceRoot).digest("hex");
  const systemDirectory = path.join(E2E_HOME_PATH, ".afk/workspaces", workspaceHash);
  expect(JSON.parse(await readFile(path.join(systemDirectory, "execution-manifest.json"), "utf8"))).toMatchObject({
    workItemId: `github:acme/api#${issueNumber}`,
    repositories: [expect.objectContaining({ checkoutPath: "repositories/api" })],
  });
  expect(JSON.parse(await readFile(path.join(systemDirectory, "work-item-runs.json"), "utf8"))).toEqual([
    expect.objectContaining({ workspacePath: workspaceRoot, status: "completed" }),
  ]);
  expect(await readdir(workspaceRoot)).not.toContain(".afk");
  await detail.getByRole("button", { name: "关闭工作项详情" }).click();
  await page.getByRole("button", { name: "刷新工作项" }).click();
  await page.getByRole("radiogroup", { name: "工作项快捷状态" }).getByRole("radio", { name: /^全部/ }).click();
  await page.locator(".backlog-row", { hasText: title }).click();
  await expect(detail.getByRole("button", { name: "处理合并" })).toBeVisible();
  await detail.getByRole("button", { name: "处理合并" }).click();

  const mergedRow = page.locator(".backlog-row", { hasText: title });
  await expect(mergedRow).toContainText("待合并");
  await mergedRow.getByRole("button", { name: "确认合并" }).click();
  await expect(mergedRow).toContainText("已完成");
});
