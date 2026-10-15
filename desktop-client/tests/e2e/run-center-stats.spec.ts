import path from "node:path";
import type { RunEventDraft } from "@afk/core";
import { JsonlEventStore } from "../../../src/infrastructure/observability/jsonl-event-store";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch";

async function seedEvents(store: JsonlEventStore) {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const base: Omit<RunEventDraft, "id" | "type" | "data"> = {
    schemaVersion: 1,
    occurredAt: "2026-10-13T10:00:00Z",
    correlationId: "run-seed",
    context: { traceId: "run-seed", runId: "run-seed", workItemId: "github:acme/web#1", profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
  };
  const cases: Array<{ status: string; nextStep: string; tokens: number }> = [
    { status: "running", nextStep: "正在分析代码结构", tokens: 1200 },
    { status: "running", nextStep: "任务空间：/tmp/workspace-a", tokens: 1320 },
    { status: "awaiting_human", nextStep: "需要人工确认", tokens: 1440 },
    { status: "failed", nextStep: "执行失败：超时", tokens: 1560 },
    { status: "succeeded", nextStep: "任务空间：/tmp/workspace-b", tokens: 1680 },
    { status: "succeeded", nextStep: "任务空间：/tmp/workspace-c", tokens: 1800 },
  ];
  for (const [i, { status, nextStep, tokens }] of cases.entries()) {
    const runId = `run-${i}`;
    const requested: RunEventDraft = {
      ...base,
      id: `${runId}-req`,
      correlationId: runId,
      context: { ...base.context, runId, workItemId: `github:acme/web#${i + 1}` },
      type: "run.requested",
      data: { kind: "run.requested", run: { id: runId, workItemId: `github:acme/web#${i + 1}`, profileId: "default", attempt: 1, status: "pending" } },
    };
    const recorded: RunEventDraft = {
      ...base,
      id: `${runId}-rec`,
      correlationId: runId,
      context: { ...base.context, runId, workItemId: `github:acme/web#${i + 1}` },
      type: "agent.session_recorded",
      occurredAt: tomorrow,
      data: {
        kind: "agent.session_recorded",
        sessionId: `${runId}-session`,
        usage: { inputTokens: 1000 + i * 100, outputTokens: 200 + i * 20, totalTokens: tokens },
        status,
        nextStep,
      },
    };
    await store.append([requested, recorded]);
  }
}

test("stats bar and segmented control render in queue view", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await seedEvents(store);

  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  await page.waitForTimeout(600);

  // Stats bar is visible with 4 cells
  const stats = page.locator(".stats");
  await expect(stats).toBeVisible();
  const statDivs = stats.locator("div");
  await expect(statDivs).toHaveCount(4);
  // Labels are present
  await expect(stats).toContainText("运行中");
  await expect(stats).toContainText("等待确认");
  await expect(stats).toContainText("失败");
  await expect(stats).toContainText("今日完成");

  // Segmented control is present with all/open/fail
  const seg = page.getByRole("radiogroup", { name: "运行筛选" });
  await expect(seg).toBeVisible();
  await expect(seg.getByText("全部")).toBeVisible();
  await expect(seg.getByText("进行中")).toBeVisible();
  await expect(seg.getByText("失败")).toBeVisible();
});

test("segmented filter updates runFilter state", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await seedEvents(store);

  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  await page.waitForTimeout(600);

  // "全部" is selected by default (events from workItemRuns = 6 queued items)
  const allRadio = page.getByRole("radiogroup", { name: "运行筛选" }).getByText("全部");
  await expect(allRadio).toHaveAttribute("aria-checked", "true");

  // Click "进行中" — filter state updates (even if count is 0 with seed data,
  // the control is functional)
  await page.getByRole("radiogroup", { name: "运行筛选" }).getByText("进行中").click();
  await page.waitForTimeout(100);
  const openRadio = page.getByRole("radiogroup", { name: "运行筛选" }).getByText("进行中");
  await expect(openRadio).toHaveAttribute("aria-checked", "true");

  // Click "失败"
  await page.getByRole("radiogroup", { name: "运行筛选" }).getByText("失败").click();
  await page.waitForTimeout(100);
  const failRadio = page.getByRole("radiogroup", { name: "运行筛选" }).getByText("失败");
  await expect(failRadio).toHaveAttribute("aria-checked", "true");

  // Back to 全部
  await page.getByRole("radiogroup", { name: "运行筛选" }).getByText("全部").click();
  await page.waitForTimeout(100);
  await expect(allRadio).toHaveAttribute("aria-checked", "true");
});

test("column headers are present in queue view", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await seedEvents(store);

  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  await page.waitForTimeout(600);

  const colHead = page.locator(".run-col-head");
  await expect(colHead).toBeVisible();
  await expect(colHead.locator("span").nth(1)).toHaveText("运行");
  await expect(colHead.locator("span").nth(2)).toHaveText("耗时");
  await expect(colHead.locator("span").nth(3)).toHaveText("更新");
});
