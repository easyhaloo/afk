import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunEventDraft } from "@afk/core";
import { JsonlEventStore } from "../../../src/infrastructure/observability/jsonl-event-store";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch";

test("keeps healthy audited runs visible when other streams fail integrity or replay", async ({ page }) => {
  const root = path.join(E2E_HOME_PATH, ".afk", "events");
  const store = new JsonlEventStore({ root });
  const workItemId = "github:acme/api#1";
  const requested = (runId: string): RunEventDraft => ({
    id: `event-${runId}`, schemaVersion: 1, type: "run.requested",
    occurredAt: "2026-10-10T00:00:00.000Z", correlationId: runId,
    context: { traceId: runId, runId, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
    data: { kind: "run.requested", run: { id: runId, workItemId, profileId: "default", attempt: 1, status: "pending" } },
  });
  await store.append([requested("healthy-run")]);
  await store.append([requested("attempt-1")]);
  const corruptedPath = path.join(root, `${Buffer.from("attempt-1").toString("base64url")}.jsonl`);
  const corrupted = JSON.parse(await readFile(corruptedPath, "utf8"));
  corrupted.integrity.hash = "tampered";
  const corruptedContent = `${JSON.stringify(corrupted)}\n`;
  await writeFile(corruptedPath, corruptedContent);
  await store.append([{ ...requested("non-replayable"), type: "qa.started", data: { kind: "qa.started" } }]);

  await expect(store.verify("attempt-1")).resolves.toMatchObject({ valid: false, reason: "integrity_mismatch" });
  const result = await page.evaluate(workItemId => window.afkDesktop.workItems.executions({ workItemId }), workItemId);
  expect(result.executions.map(run => run.runId)).toEqual(["healthy-run"]);
  await page.locator(".backlog-row.work-item-row", { hasText: "API 登录态切换" }).click();
  const detail = page.getByRole("dialog", { name: `工作项 ${workItemId}` });
  await detail.getByRole("button", { name: /运行记录/ }).click();
  await expect(detail.locator(".work-item-run-card")).toHaveCount(1);
  await expect(detail.locator(".work-item-run-card")).toContainText("healthy-run");
  await expect(detail.locator(".work-item-run-error")).toHaveCount(0);
  await detail.getByRole("button", { name: "接管", exact: true }).click();
  const terminal = page.locator(".terminal-sheet");
  await expect(terminal).toContainText("该运行没有已登记的执行环境资源");
  await expect(terminal.locator("input")).toHaveCount(0);
  expect(await terminal.evaluate(panel => {
    const bounds = panel.getBoundingClientRect();
    return panel.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
  expect(await readFile(corruptedPath, "utf8")).toBe(corruptedContent);
  await expect(store.verify("attempt-1")).resolves.toMatchObject({ valid: false, reason: "integrity_mismatch" });
});

test("shows the same advancing audited timeline in the work item and run center", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  const runId = "timeline-e2e-run";
  const workItemId = "github:acme/api#1";
  let eventNumber = 0;
  const draft = (data: RunEventDraft["data"]): RunEventDraft => ({
    id: `timeline-${++eventNumber}`, schemaVersion: 1, type: data.kind,
    occurredAt: new Date(Date.UTC(2026, 9, 15, 1, 0, eventNumber)).toISOString(), correlationId: runId,
    context: { traceId: runId, runId, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
    data,
  });
  await store.append([
    draft({ kind: "run.requested", run: { id: runId, workItemId, profileId: "default", attempt: 1, status: "pending" } }),
    draft({ kind: "run.started" }),
    draft({ kind: "workflow.recorded", name: "issue-implementation", version: 1, steps: [
      { id: "implement", kind: "agent", dependsOn: [], provider: "opencode", executionMode: "interactive" },
      { id: "verify-ac", kind: "agent", dependsOn: ["implement"], provider: "opencode", executionMode: "interactive" },
    ] }),
    draft({ kind: "workspace.prepared", workspace: "/tmp/recorded-task", branch: "afk/task", baseBranch: "main" }),
    draft({ kind: "step.started", stepId: "implement", phase: "implementation" }),
  ]);
  await page.locator(".backlog-row.work-item-row", { hasText: "API 登录态切换" }).click();
  const detail = page.getByRole("dialog", { name: `工作项 ${workItemId}` });
  await detail.getByRole("button", { name: /运行记录/ }).click();
  await detail.getByLabel(`查看运行 ${runId} 的执行时间线`).click();
  const timeline = detail.getByLabel(`运行 ${runId} 事件时间线`);
  await expect(timeline).toContainText("implement");
  await expect(timeline).toContainText("/tmp/recorded-task");
  await expect(timeline).toContainText("issue-implementation v1");
  await expect(timeline).toContainText("依赖 implement");
  await store.append([
    draft({ kind: "step.completed", stepId: "implement", outcome: "succeeded" }),
    draft({ kind: "step.started", stepId: "verify-ac", phase: "verification" }),
  ]);
  await expect(timeline).toContainText("verify-ac", { timeout: 12000 });
  await expect(timeline).toContainText("#7");
  if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/work-item-live-timeline.png` });
  await page.getByRole("button", { name: "关闭工作项详情", exact: true }).click();
  await page.locator(".primary-nav").getByRole("button", { name: "运行中心", exact: true }).click();
  await page.locator(".event-row").filter({ hasText: "#1" }).first().click();
  const inspector = page.getByLabel("运行详情", { exact: true });
  await inspector.getByLabel(`查看运行 ${runId} 的执行时间线`).click();
  await expect(inspector.getByLabel(`运行 ${runId} 事件时间线`)).toContainText("verify-ac");
  if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/run-center-same-timeline.png` });
});

test("keeps workflow instance identity across all surfaces and separates health from progress", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  const runId = "instance-navigation-run";
  const workItemId = "github:acme/api#1";
  const runtimeDirectory = path.join(E2E_HOME_PATH, ".afk", "runtime", "tasks", "active");
  await mkdir(runtimeDirectory, { recursive: true });
  const runtimeFile = path.join(runtimeDirectory, `${Buffer.from(runId).toString("base64url")}.json`);
  const runtime = { runId, providerRef: workItemId, status: "running", heartbeatAt: new Date().toISOString(), agentProvider: "opencode", agentTransport: "process", executionMode: "interactive" };
  await writeFile(runtimeFile, JSON.stringify(runtime));
  const snapshot = await page.evaluate(() => window.afkDesktop.snapshot(""));
  const template = snapshot.workflowTemplates[0];
  expect(template).toBeDefined();
  const stepId = "recorded-step-only";
  let sequence = 0;
  const draft = (data: RunEventDraft["data"]): RunEventDraft => ({
    id: `instance-${++sequence}`, schemaVersion: 1, type: data.kind, occurredAt: new Date().toISOString(), correlationId: runId,
    context: { traceId: runId, runId, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } }, data,
  });
  await store.append([
    draft({ kind: "run.requested", run: { id: runId, workItemId, profileId: "default", attempt: 1, status: "pending" } }),
    draft({ kind: "run.started" }),
    draft({ kind: "workflow.recorded", name: template.id, version: 1, steps: [{ id: stepId, kind: "agent", dependsOn: [], provider: "opencode", executionMode: "interactive" }] }),
    draft({ kind: "workspace.prepared", workspace: snapshot.workspace.root, branch: "recorded-branch", baseBranch: "main" }),
    draft({ kind: "step.started", stepId, phase: "implementation" }),
  ]);
  await page.locator(".backlog-row.work-item-row", { hasText: "API 登录态切换" }).click();
  const drawer = page.getByRole("dialog", { name: `工作项 ${workItemId}` });
  await drawer.getByRole("button", { name: /运行记录/ }).click();
  await drawer.getByLabel(`查看运行 ${runId} 的工作流实例`).click();
  const instance = page.getByRole("region", { name: "工作流实例" });
  await expect(instance).toContainText(runId);
  await expect(instance.getByRole("region", { name: "运行健康" })).toContainText("存活");
  await expect(instance.locator("tbody")).toContainText(stepId);
  await writeFile(runtimeFile, JSON.stringify({ ...runtime, heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
  await expect(instance.getByRole("region", { name: "运行健康" })).toContainText("心跳过期", { timeout: 12000 });
  await expect(instance).toContainText("审计进度：执行中");
  if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/workflow-instance-stale-health.png` });
  await instance.getByLabel("查看当前工作流定义").click();
  await expect(page.getByLabel("工作流画布编辑器")).toBeVisible();
  await page.getByRole("radio", { name: "运行实例", exact: true }).click();
  await expect(instance.locator("tbody")).toContainText(stepId);
  await instance.getByLabel("查看本次执行环境").click();
  await expect(page.getByRole("region", { name: "执行环境", exact: true })).toContainText(runId);
  await page.getByRole("button", { name: "返回工作流实例", exact: true }).click();
  await instance.getByLabel("查看本次运行").click();
  const inspector = page.getByLabel("运行详情", { exact: true });
  await inspector.getByLabel("查看本次工作流实例").click();
  await expect(instance).toContainText(runId);
  await instance.getByLabel("查看关联工作项").click();
  await expect(drawer).toBeVisible();
  expect(await readFile(runtimeFile, "utf8")).toContain(runId);
});
