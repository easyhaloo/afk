import path from "node:path";
import type { RunEventDraft } from "@afk/core";
import { JsonlEventStore } from "@afk/infrastructure/observability";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch";

test("shows audited agent tokens and distinguishes missing telemetry from zero", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  const cases = [
    { runId: "usage-run", workItemId: "github:acme/api#1", usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }, values: ["120", "30", "150"] },
    { runId: "zero-run", workItemId: "github:acme/web#1", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, values: ["0", "0", "0"] },
    { runId: "missing-run", workItemId: "github:acme/api#2", usage: undefined, values: ["未采集", "未采集", "未采集"] },
  ];
  for (const item of cases) {
    const requested: RunEventDraft = {
      id: `${item.runId}-requested`, schemaVersion: 1, type: "run.requested",
      occurredAt: "2026-10-13T00:00:00Z", correlationId: item.runId,
      context: { traceId: item.runId, runId: item.runId, workItemId: item.workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
      data: { kind: "run.requested", run: { id: item.runId, workItemId: item.workItemId, profileId: "default", attempt: 1, status: "pending" } },
    };
    await store.append([requested, { ...requested, id: `${item.runId}-usage`, type: "agent.session_recorded", data: { kind: "agent.session_recorded", sessionId: `${item.runId}-session`, ...(item.usage ? { usage: item.usage } : {}) } }]);
  }
  const result = await page.evaluate(() => window.afkDesktop.workItems.executions());
  expect(result.executions.find(run => run.runId === "usage-run")?.usage).toEqual(cases[0].usage);
  expect(result.executions.find(run => run.runId === "zero-run")?.usage?.totalTokens).toBe(0);
  expect(result.executions.find(run => run.runId === "missing-run")).not.toHaveProperty("usage");
  await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
  for (const item of cases) {
    await page.getByRole("button", { name: `查看待执行运行 ${item.workItemId} 的详情` }).click();
    const details = page.getByRole("complementary", { name: "运行详情" });
    await expect(details.locator('dl[aria-label="Agent token 用量"] dd')).toHaveText(item.values);
    await expect(details.locator(".inspector-flow")).toContainText("待执行");
  }
});
