import path from "node:path";
import type { ObservationContext, RunEventData } from "@afk/core";
import { ExperienceStore, experienceStorePath } from "@afk/runtime/execution";
import { JsonlEventStore } from "@afk/runtime/infrastructure/observability/jsonl-event-store";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch.js";

test("lists, recalls, independently verifies and revokes real project-scoped experience through Settings IPC", async ({ page, electronApp }) => {
  const file = experienceStorePath(E2E_HOME_PATH);
  const store = new ExperienceStore({ file });
  let record;
  try {
    record = store.recordFailure({ scope: "github:acme/api", trigger: "network.timeout", rootCause: "Missing proxy", action: "Inspect network settings", evidence: ["run:failed-original#failure.classified"], source: { runId: "failed-original", workItemId: "github:acme/api#1" } });
    store.recordFailure({ scope: "github:acme/web", trigger: "foreign.project.failure", rootCause: "Unrelated project", action: "Inspect web", evidence: ["run:failed-web#failure.classified"], source: { runId: "failed-web", workItemId: "github:acme/web#1" } });
  } finally { store.close(); }
  const eventRoot = path.join(E2E_HOME_PATH, ".afk", "events");
  await electronApp.evaluate((_electron, root) => { process.env.AFK_EVENT_STORE_DIR = root; }, eventRoot);
  const runId = "independent-desktop-qa";
  const context: ObservationContext = { traceId: runId, runId, workItemId: "github:acme/api#2", profileId: "local", attempt: 1, actor: { kind: "system", id: "desktop-e2e" } };
  const data: RunEventData[] = [{ kind: "qa.started" }, { kind: "qa.passed" }, { kind: "run.finished", outcome: "succeeded" }];
  const events = new JsonlEventStore({ root: eventRoot });
  await events.append(data.map((data, index) => ({ id: `${runId}-${index}`, schemaVersion: 1, type: data.kind, occurredAt: new Date().toISOString(), context, correlationId: runId, data })));
  expect(await events.verify(runId)).toMatchObject({ valid: true, lastSequence: 3 });
  const originalRun = "failed-original";
  await events.append(data.map((data, index) => ({ id: `${originalRun}-${index}`, schemaVersion: 1, type: data.kind, occurredAt: new Date().toISOString(), context: { ...context, traceId: originalRun, runId: originalRun, workItemId: record.source.workItemId }, correlationId: originalRun, data })));
  expect(await events.verify(originalRun)).toMatchObject({ valid: true, lastSequence: 3 });

  await page.locator(".sidebar-bottom .settings-entry").click();
  const experiences = page.getByRole("region", { name: "经验管理", exact: true });
  await expect(experiences.getByRole("button", { name: "查询经验", exact: true })).toBeDisabled();
  await experiences.getByRole("button", { name: "经验项目", exact: true }).click();
  await experiences.getByRole("option", { name: "github:acme/api", exact: true }).click();
  const row = experiences.locator(".plugin-list > li").filter({ hasText: "network.timeout" });
  await expect(row).toContainText("待验证");
  await expect(experiences).not.toContainText("foreign.project.failure");
  await experiences.getByRole("textbox", { name: "召回内容", exact: true }).fill("network");
  await experiences.getByRole("button", { name: "查询经验", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(experiences).toContainText("没有匹配记录");
  await experiences.getByRole("textbox", { name: "召回内容", exact: true }).fill("");
  await experiences.getByRole("button", { name: "查询经验", exact: true }).click();
  await row.getByRole("button", { name: `验证 ${record.id}`, exact: true }).click();
  const verification = experiences.getByRole("form", { name: "独立验证经验", exact: true });
  await verification.getByRole("textbox", { name: "独立验证运行", exact: true }).fill("failed-original");
  await verification.getByRole("textbox", { name: "已验证修正", exact: true }).fill("Configure network proxy");
  await verification.getByRole("button", { name: "验证并保存", exact: true }).click();
  await expect(experiences.getByRole("alert")).toContainText("独立 QA");
  await expect(row).toContainText("待验证");
  await verification.getByRole("textbox", { name: "独立验证运行", exact: true }).fill(runId);
  await verification.getByRole("button", { name: "验证并保存", exact: true }).click();
  await expect(verification).toHaveCount(0);
  await expect(row).toContainText("已验证");
  await expect(row).toContainText(`run:${runId}#qa.passed`);
  await experiences.getByRole("textbox", { name: "召回内容", exact: true }).fill("network");
  await experiences.getByRole("button", { name: "查询经验", exact: true }).click();
  await expect(row).toBeVisible();
  const consumer = { runId: "experience-desktop-consumer", workItemId: "github:acme/api#3" };
  const selectedStore = new ExperienceStore({ file, now: () => new Date(Date.now() - 1000) });
  try {
    expect(selectedStore.get(record.id, record.scope)).toMatchObject({ status: "verified", verifiedEvidence: { runId } });
    const retrieved = selectedStore.recordContextRetrieval({ id: record.id, scope: record.scope, source: consumer,
      selectionId: "12345678-1234-4234-8234-123456789012", fragmentDigest: "a".repeat(64) });
    selectedStore.recordContextSelection({ retrieved, fragmentDigest: "b".repeat(64) });
    const occurredAt = new Date().toISOString();
    selectedStore.recordRunOutcome({ scope: record.scope, source: consumer, event: { runId: consumer.runId,
      sequence: 3, hash: "c".repeat(64), type: "run.finished", outcome: "succeeded", occurredAt, observedAt: occurredAt } });
    selectedStore.recordRunOutcome({ scope: record.scope, source: consumer, event: { runId: consumer.runId,
      sequence: 4, hash: "d".repeat(64), type: "qa.failed", outcome: "failed", occurredAt, observedAt: occurredAt },
      failure: { scope: record.scope, trigger: record.trigger, rootCause: record.rootCause, action: "Configure network proxy",
        source: consumer, evidence: ["run:experience-desktop-consumer#qa.failed"] } });
    expect(selectedStore.outcomeReceipts({ scope: record.scope, source: consumer })).toHaveLength(2);
    expect(selectedStore.get(record.id, record.scope)?.status).toBe("candidate");
    expect(selectedStore.get(record.id, record.scope)?.verifiedEvidence).toBeUndefined();
    expect(selectedStore.metrics({ scope: record.scope }).adoptions).toBe(0);
  } finally { selectedStore.close(); }
  const outcomes = experiences.getByRole("region", { name: "经验结果收据", exact: true });
  await outcomes.getByRole("textbox", { name: "结果运行 ID", exact: true }).fill(consumer.runId);
  await outcomes.getByRole("textbox", { name: "结果工作项 ID", exact: true }).fill(consumer.workItemId);
  await outcomes.getByRole("button", { name: "提交结果查询", exact: true }).click();
  await expect(outcomes.getByRole("status")).toContainText("结果收据 2 条");
  const outcomeRows = outcomes.locator(".plugin-list > li");
  await expect(outcomeRows).toHaveCount(2);
  await expect(outcomeRows.first()).toContainText("失败 · 已记录复发 · 收益未知");
  await expect(outcomeRows.last()).toContainText("成功 · 本收据未记录复发 · 收益未知");
  await outcomes.getByRole("textbox", { name: "结果工作项 ID", exact: true }).fill("github:acme/api#4");
  await outcomes.getByRole("button", { name: "提交结果查询", exact: true }).click();
  await expect(outcomes.getByRole("status")).toHaveText("没有结果收据");
  await expect(outcomeRows).toHaveCount(0);
  await outcomes.getByRole("textbox", { name: "结果工作项 ID", exact: true }).fill(consumer.workItemId);
  await outcomes.getByRole("button", { name: "提交结果查询", exact: true }).click();
  await expect(outcomeRows).toHaveCount(2);
  await row.getByRole("button", { name: `撤销 ${record.id}`, exact: true }).click();
  await page.getByRole("button", { name: "确认撤销经验", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(experiences).toContainText("没有匹配记录");
  await outcomes.getByRole("button", { name: "提交结果查询", exact: true }).click();
  await expect(outcomeRows).toHaveCount(2);
  const persisted = new ExperienceStore({ file });
  try {
    expect(persisted.get(record.id, record.scope)?.status).toBe("revoked");
    expect(persisted.get(record.id, record.scope)?.verifiedEvidence).toBeUndefined();
    expect(persisted.metrics({ scope: record.scope }).adoptions).toBe(0);
    expect(persisted.outcomeReceipts({ scope: record.scope, source: consumer })).toHaveLength(2);
  }
  finally { persisted.close(); }
});
