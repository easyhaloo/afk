import path from "node:path";
import type { RunEventDraft } from "@afk/core";
import { JsonlEventStore } from "../../../src/infrastructure/observability/jsonl-event-store";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch";

function pastTimestamp(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

async function seedEvents(store: JsonlEventStore) {
  const base: Omit<RunEventDraft, "id" | "type" | "data"> = {
    schemaVersion: 1,
    occurredAt: "2026-10-13T10:00:00Z",
    correlationId: "run-seed",
    context: { traceId: "run-seed", runId: "run-seed", workItemId: "github:acme/web#1", profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
  };
  const cases: Array<{ status: string; nextStep: string; tokens: number; hoursAgo: number }> = [
    { status: "running", nextStep: "正在分析代码结构", tokens: 1200, hoursAgo: 1 },
    { status: "running", nextStep: "任务空间：/tmp/workspace-a", tokens: 1320, hoursAgo: 2 },
    { status: "awaiting_human", nextStep: "需要人工确认", tokens: 1440, hoursAgo: 3 },
    { status: "failed", nextStep: "执行失败：超时", tokens: 1560, hoursAgo: 4 },
    { status: "succeeded", nextStep: "任务空间：/tmp/workspace-b", tokens: 1680, hoursAgo: 5 },
    { status: "succeeded", nextStep: "任务空间：/tmp/workspace-c", tokens: 1800, hoursAgo: 6 },
  ];
  for (const [i, { status, nextStep, tokens, hoursAgo }] of cases.entries()) {
    const runId = `run-${i}`;
    const occurredAt = pastTimestamp(hoursAgo);
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
      occurredAt,
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

test("stats bar, segmented control, and column headers are visible", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await seedEvents(store);

  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  await page.waitForTimeout(600);

  const stats = page.locator(".stats");
  await expect(stats).toBeVisible();
  const statDivs = stats.locator("div");
  await expect(statDivs).toHaveCount(4);
  await expect(stats).toContainText("运行中");
  await expect(stats).toContainText("等待确认");
  await expect(stats).toContainText("失败");
  await expect(stats).toContainText("今日完成");

  const seg = page.getByRole("radiogroup", { name: "运行筛选" });
  await expect(seg).toBeVisible();
  await expect(seg.getByText("全部")).toBeVisible();
  await expect(seg.getByText("进行中")).toBeVisible();
  await expect(seg.getByText("失败")).toBeVisible();
});

test("segmented filter toggles aria-checked state", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await seedEvents(store);

  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  await page.waitForTimeout(600);

  const allRadio = page.getByRole("radiogroup", { name: "运行筛选" }).getByText("全部");
  await expect(allRadio).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radiogroup", { name: "运行筛选" }).getByText("进行中").click();
  await page.waitForTimeout(100);
  await expect(page.getByRole("radiogroup", { name: "运行筛选" }).getByText("进行中")).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radiogroup", { name: "运行筛选" }).getByText("失败").click();
  await page.waitForTimeout(100);
  await expect(page.getByRole("radiogroup", { name: "运行筛选" }).getByText("失败")).toHaveAttribute("aria-checked", "true");

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
  // 3 columns: 空 / 运行 / 更新
  await expect(colHead.locator("span").nth(1)).toHaveText("运行");
  await expect(colHead.locator("span").nth(2)).toHaveText("更新");
});

test("column header and row grid alignment — head span offsets match row cell offsets within 3px", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await seedEvents(store);

  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  await page.waitForTimeout(600);

  const headOffsets = await page.evaluate(() => {
    const head = document.querySelector(".run-col-head");
    if (!head) return null;
    return Array.from(head.querySelectorAll("span")).map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, left: r.left, width: r.width };
    });
  });

  const rowOffsets = await page.evaluate(() => {
    const row = document.querySelector(".queue .event-row");
    if (!row) return null;
    return Array.from(row.children).map((el, i) => {
      const r = el.getBoundingClientRect();
      return { index: i, left: r.left, width: r.width };
    });
  });

  expect(headOffsets, "run-col-head not found in DOM").not.toBeNull();
  expect(rowOffsets, "event-row not found in DOM").not.toBeNull();

  console.log("head offsets:", JSON.stringify(headOffsets));
  console.log("row offsets:", JSON.stringify(rowOffsets));

  // head[0] = empty cell, head[1] = 运行, head[2] = 更新
  // row[0] = StateGlyph(22px), row[1] = .run-main, row[2] = event-time(96px), row[3] = chevron
  const headCol1Left = headOffsets![1].left;
  const rowCol1Left = rowOffsets![1].left;
  expect(Math.abs(headCol1Left - rowCol1Left), `col1 运行: head=${headCol1Left} row=${rowCol1Left} gap=${Math.abs(headCol1Left - rowCol1Left)}`).toBeLessThanOrEqual(3);

  const headCol2Left = headOffsets![2].left;
  const rowCol2Left = rowOffsets![2].left;
  expect(Math.abs(headCol2Left - rowCol2Left), `col2 更新: head=${headCol2Left} row=${rowCol2Left} gap=${Math.abs(headCol2Left - rowCol2Left)}`).toBeLessThanOrEqual(3);

  expect(rowOffsets).toHaveLength(3);
  expect(headOffsets).toHaveLength(3);
});

test("event-row child count matches grid columns (4 cells)", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await seedEvents(store);
  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  await page.waitForTimeout(600);

  const info = await page.evaluate(() => {
    const row = document.querySelector(".queue .event-row");
    return { childCount: row ? row.children.length : -1, html: row ? row.innerHTML.substring(0, 300) : "" };
  });
  expect(info.childCount, `expected 3 children but got ${info.childCount}. Row HTML: ${info.html}`).toBe(3);
});
