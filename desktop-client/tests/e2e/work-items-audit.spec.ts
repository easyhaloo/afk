import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunEventDraft } from "@afk/core";
import { JsonlEventStore } from "../../../src/infrastructure/observability/jsonl-event-store";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch";

test("shows launch records with local timestamps and recorded workflow metadata", async ({ page, electronApp }) => {
  const inventory = await page.evaluate(() => window.afkDesktop.workItems.list());
  const workItemId = "github:acme/api#1";
  const runId = "desktop-2954a4d0-d193-4a39-95dc-e2b61cb69305";
  const startedAt = new Date(2026, 9, 19, 20, 16, 17, 270).toISOString();
  const auditedRunId = "desktop-7d41a886-2be8-48cf-81ba-0b8e6a5c9320";
  const auditContext = { traceId: auditedRunId, runId: auditedRunId, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli" as const, id: "e2e" } };
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  await store.append([
    { id: "requested-heading", schemaVersion: 1, type: "run.requested", occurredAt: "2026-10-19T12:16:17.270Z", context: auditContext, correlationId: auditedRunId,
      data: { kind: "run.requested", run: { id: auditedRunId, workItemId, profileId: "default", attempt: 1, status: "pending", phase: "implementation" } } },
    { id: "started-heading", schemaVersion: 1, type: "run.started", occurredAt: "2026-10-19T12:16:54.000Z", context: auditContext, correlationId: auditedRunId, data: { kind: "run.started" } },
  ]);
  await electronApp.evaluate(({ ipcMain }, input) => {
    ipcMain.removeHandler(input.channel);
    ipcMain.handle(input.channel, () => ({ ...input.inventory, items: input.inventory.items.map(item => item.id === input.workItemId
      ? { ...item, runs: [
        { id: input.runId, status: "failed", startedAt: input.startedAt, workspacePath: "/isolated/task" },
        { id: "desktop-a5a486e4-68ed-4f8a-8806-a1ddca12c27d", status: "failed", startedAt: "2026-10-19T11:22:22.462Z", workflow: "issue-implementation", workspacePath: "/isolated/task", error: "启动超时：等待 Agent 就绪" },
      ] }
      : item) }));
  }, { channel: IPC_CHANNELS.workItemsList, inventory, workItemId, runId, startedAt });
  await electronApp.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, value) => { Reflect.set(globalThis, "copiedRunId", value); return true; });
  }, IPC_CHANNELS.copyText);
  await page.reload();
  await page.locator(".primary-nav").getByRole("button", { name: "工作项" }).click();
  await page.locator(".backlog-row.work-item-row", { hasText: "API 登录态切换" }).click();
  const drawer = page.getByRole("dialog", { name: `工作项 ${workItemId}` });
  await drawer.getByRole("button", { name: /运行记录/ }).click();
  const history = drawer.locator(".work-item-run-history");
  const inspector = drawer.getByRole("region", { name: "运行详情" });
  const shell = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect();
    const topbar = document.querySelector(".topbar")!.getBoundingClientRect();
    const detail = document.querySelector(".work-item-detail")!.getBoundingClientRect();
    const layer = document.querySelector(".work-item-detail-layer")!.getBoundingClientRect();
    const unobscured = (selector: string) => {
      const element = document.querySelector(selector)!;
      const bounds = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    };
    return { sidebarRight: sidebar.right, topbarBottom: topbar.bottom, detailLeft: detail.left, layerLeft: layer.left, layerTop: layer.top, sidebarClear: unobscured(".sidebar"), topbarClear: unobscured(".topbar") };
  });
  expect(shell.sidebarClear).toBe(true);
  expect(shell.topbarClear).toBe(true);
  expect(shell.layerLeft).toBeGreaterThanOrEqual(shell.sidebarRight);
  expect(shell.layerTop).toBeGreaterThanOrEqual(shell.topbarBottom);
  expect(shell.detailLeft - shell.sidebarRight).toBeGreaterThanOrEqual(240);
  await expect(history.locator(".work-item-run-card")).toHaveCount(3);
  await expect(history.locator(`.work-item-run-card[data-run-id="${auditedRunId}"]`)).toHaveAttribute("data-selected", "true");
  await expect(inspector).toContainText("20:16:54");
  await expect(inspector).toContainText("运行审计");
  const card = drawer.locator(`.work-item-run-card[data-run-id="${runId}"]`);
  await expect(card.locator("time")).toHaveText("2026/10/19 20:16:17");
  await expect(card.locator("time")).toHaveAttribute("datetime", startedAt);
  await expect(card.locator("time")).toHaveAttribute("title", /本地时间（.+）/);
  const timestampFits = await card.locator("time").evaluate(element => {
    const parent = element.parentElement!;
    return element.getBoundingClientRect().width <= parent.getBoundingClientRect().width;
  });
  expect(timestampFits).toBe(true);
  const auditedCard = drawer.locator(`.work-item-run-card[data-run-id="${auditedRunId}"]`);
  await expect(auditedCard.locator("b")).toHaveText("2026/10/19 20:16:54");
  await expect(inspector.getByRole("button", { name: `查看运行 ${auditedRunId} 的工作流实例` })).toBeVisible();
  const previousCard = drawer.locator('.work-item-run-card[data-run-id="desktop-a5a486e4-68ed-4f8a-8806-a1ddca12c27d"]');
  await expect(previousCard.locator(".work-item-run-summary")).toHaveText("启动超时：等待 Agent 就绪");
  await expect(previousCard.locator(".work-item-run-summary")).toBeVisible();
  if (process.env.AFK_UI_EVIDENCE_DIR) {
    await mkdir(process.env.AFK_UI_EVIDENCE_DIR, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.afkTheme = theme; }, theme);
      await drawer.locator(".work-item-detail-section").screenshot({ path: path.join(process.env.AFK_UI_EVIDENCE_DIR, `work-item-run-history-${theme}.png`) });
      await page.screenshot({ path: path.join(process.env.AFK_UI_EVIDENCE_DIR, `desktop-run-history-${theme}.png`), scale: "css" });
    }
  }
  const listBounds = await history.locator(".work-item-run-list").boundingBox();
  await card.getByRole("button").focus();
  await card.getByRole("button").press("Enter");
  await expect(inspector).toContainText("20:16:17");
  await expect(inspector.locator(".work-item-run-inspector-meta")).toContainText("失败原因未记录");
  await expect(inspector).toContainText("/isolated/task");
  expect(await history.locator(".work-item-run-list").boundingBox()).toEqual(listBounds);
  await inspector.getByRole("button", { name: `复制运行 ${runId} 的完整编号` }).click();
  await expect(inspector.getByRole("status")).toHaveText("已复制");
  expect(await electronApp.evaluate(() => Reflect.get(globalThis, "copiedRunId"))).toBe(runId);
  if (process.env.AFK_UI_EVIDENCE_DIR) {
    await page.evaluate(() => { document.documentElement.dataset.afkTheme = "light"; });
    await drawer.locator(".work-item-detail-section").screenshot({ path: path.join(process.env.AFK_UI_EVIDENCE_DIR, "work-item-run-history-expanded.png") });
    await page.screenshot({ path: path.join(process.env.AFK_UI_EVIDENCE_DIR, "desktop-run-history-selected.png"), scale: "css" });
  }
  await expect(card).toHaveAttribute("data-selected", "true");
  await page.setViewportSize({ width: 1280, height: 892 });
  await expect(history.locator(".work-item-run-list")).toBeVisible();
  await expect(inspector).toBeVisible();
  if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.AFK_UI_EVIDENCE_DIR, "desktop-run-history-1280.png"), scale: "css" });
  await page.setViewportSize({ width: 760, height: 900 });
  const back = inspector.getByRole("button", { name: "返回运行记录" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(inspector).toBeHidden();
  await expect(card.getByRole("button")).toBeFocused();
  await card.getByRole("button").press("Space");
  await expect(history.locator(".work-item-run-list")).toBeHidden();
  await expect(inspector).toBeVisible();
  await expect(inspector).toBeFocused();
  if (process.env.AFK_UI_EVIDENCE_DIR) await drawer.screenshot({ path: path.join(process.env.AFK_UI_EVIDENCE_DIR, "work-item-run-history-narrow.png") });
  if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.AFK_UI_EVIDENCE_DIR, "desktop-run-history-narrow.png"), scale: "css" });
  await back.click();
  await expect(card.getByRole("button")).toBeFocused();
  await page.locator(".primary-nav").getByRole("button", { name: "运行中心", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator(".run-center-layout")).toBeVisible();
});

test("keeps a newer workflow selection when an earlier run lookup finishes", async ({ page, electronApp }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  const workItemId = "github:acme/api#1";
  await Promise.all(["lookup-first", "lookup-second"].map(runId => store.append([{
    id: `requested-${runId}`, schemaVersion: 1, type: "run.requested",
    occurredAt: "2026-10-10T00:00:00.000Z", correlationId: runId,
    context: { traceId: runId, runId, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
    data: { kind: "run.requested", run: { id: runId, workItemId, profileId: "default", attempt: 1, status: "pending" } },
  }])));
  await page.locator(".backlog-row.work-item-row", { hasText: "API 登录态切换" }).click();
  const drawer = page.getByRole("dialog", { name: `工作项 ${workItemId}` });
  await drawer.getByRole("button", { name: /运行记录/ }).click();
  await drawer.locator('.work-item-run-card[data-run-id="lookup-first"]').getByRole("button").click();
  await drawer.getByLabel("查看运行 lookup-first 的工作流实例").click();
  const instance = page.getByRole("region", { name: "工作流实例" });
  await expect(instance.locator("article")).toContainText("lookup-first");
  const result = await page.evaluate(workItemId => window.afkDesktop.workItems.executions({ workItemId }), workItemId);
  await electronApp.evaluate(({ ipcMain }, input) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = { pending: false, release };
    Object.assign(globalThis, { executionLookupTest: state });
    ipcMain.removeHandler(input.channel);
    ipcMain.handle(input.channel, async (_event, options) => {
      if (options?.workItemId) { state.pending = true; await gate; }
      return input.result;
    });
  }, { channel: IPC_CHANNELS.workItemsExecutions, result });
  await instance.getByLabel("查看本次运行").click();
  await expect.poll(() => electronApp.evaluate(() => Reflect.get(globalThis, "executionLookupTest").pending)).toBe(true);
  await instance.getByRole("button", { name: /lookup-second/ }).click();
  await expect(instance.locator("article")).toContainText("lookup-second");
  await electronApp.evaluate(() => Reflect.get(globalThis, "executionLookupTest").release());
  await page.evaluate(() => window.afkDesktop.workItems.executions({ limit: 100 }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(instance).toBeVisible();
  await expect(instance.locator("article")).toContainText("lookup-second");
});

test("keeps a historical run selected after refreshing the latest execution page", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  const workItemId = "github:acme/api#1";
  const runId = "a-historical-run";
  await Promise.all([runId, ...Array.from({ length: 100 }, (_, index) => `z-recent-${index}`)].map(id => store.append([{
    id: `requested-${id}`, schemaVersion: 1, type: "run.requested",
    occurredAt: "2026-10-10T00:00:00.000Z", correlationId: id,
    context: { traceId: id, runId: id, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
    data: { kind: "run.requested", run: { id, workItemId, profileId: "default", attempt: 1, status: "pending" } },
  }])));
  const firstPage = await page.evaluate(() => window.afkDesktop.workItems.executions({ limit: 100 }));
  expect(firstPage.executions.some(run => run.runId === runId)).toBe(false);
  expect(firstPage.nextCursor).toBeDefined();
  await page.clock.install();
  await page.locator(".backlog-row.work-item-row", { hasText: "API 登录态切换" }).click();
  const drawer = page.getByRole("dialog", { name: `工作项 ${workItemId}` });
  await drawer.getByRole("button", { name: /运行记录/ }).click();
  await drawer.getByRole("button", { name: "查看更多运行记录" }).click();
  await drawer.locator(`.work-item-run-card[data-run-id="${runId}"]`).getByRole("button").click();
  await drawer.getByLabel(`查看运行 ${runId} 的工作流实例`).click();
  await page.getByRole("region", { name: "工作流实例" }).getByLabel("查看本次运行").click();
  const inspector = page.getByLabel("运行详情", { exact: true });
  await expect(inspector.getByLabel("查看本次工作流实例")).toBeVisible();
  await inspector.getByLabel(`查看运行 ${runId} 的执行时间线`).click();
  await expect(inspector.getByLabel(`运行 ${runId} 事件时间线`)).toContainText("#1");
  await page.clock.fastForward(5500);
  await expect(inspector.getByLabel("查看本次工作流实例")).toBeVisible();
  await expect(inspector.getByLabel(`运行 ${runId} 事件时间线`)).toContainText("#1");
  await inspector.getByLabel("查看本次工作流实例").click();
  await expect(page.getByRole("region", { name: "工作流实例" })).toContainText(runId);
});

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
  await expect(detail.locator(".work-item-run-card")).toHaveAttribute("data-run-id", "healthy-run");
  await expect(detail.locator(".work-item-run-identity code")).toHaveAttribute("title", "healthy-run");
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
  const timeline = detail.getByLabel(`运行 ${runId} 事件时间线`);
  await expect(timeline).toContainText("implement");
  await expect(timeline).toContainText("/tmp/recorded-task");
  await expect(timeline).toContainText("issue-implementation v1");
  await expect(timeline).toContainText("依赖 implement");
  await timeline.locator(".run-log-event").first().locator("summary").click();
  await expect(timeline.locator(".run-log-event").first()).toHaveAttribute("open", "");
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
  await expect(instance.getByLabel("本次工作流快照")).toContainText(stepId);
  await writeFile(runtimeFile, JSON.stringify({ ...runtime, heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
  await expect(instance.getByRole("region", { name: "运行健康" })).toContainText("心跳过期", { timeout: 12000 });
  await expect(instance).toContainText("审计进度：执行中");
  if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/workflow-instance-stale-health.png` });
  await instance.getByLabel("查看当前工作流定义").click();
  await expect(page.getByLabel("工作流画布编辑器")).toBeVisible();
  await page.getByRole("radio", { name: "运行实例", exact: true }).click();
  await expect(instance.getByLabel("本次工作流快照")).toContainText(stepId);
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

test("shows prototype-style workflow snapshots and searchable, expandable run logs", async ({ page }) => {
  const store = new JsonlEventStore({ root: path.join(E2E_HOME_PATH, ".afk", "events") });
  const runId = "workflow-redesign-run";
  const workItemId = "github:acme/api#1";
  let sequence = 0;
  const draft = (data: RunEventDraft["data"]): RunEventDraft => ({
    id: `redesign-${++sequence}`, schemaVersion: 1, type: data.kind,
    occurredAt: new Date(Date.UTC(2026, 9, 19, 1, 18, sequence)).toISOString(), correlationId: runId,
    context: { traceId: runId, runId, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } }, data,
  });
  await store.append([
    draft({ kind: "run.requested", run: { id: runId, workItemId, profileId: "default", attempt: 1, status: "pending" } }),
    draft({ kind: "run.started" }),
    draft({ kind: "workflow.recorded", name: "issue-implementation", version: 1, steps: [
      { id: "prepare-workspace", kind: "system", dependsOn: [] },
      { id: "implement", kind: "agent", dependsOn: ["prepare-workspace"], provider: "codex", executionMode: "interactive" },
      { id: "verify-ac", kind: "agent", dependsOn: ["implement"], provider: "claude-code", executionMode: "batch" },
      { id: "publish", kind: "system", dependsOn: ["verify-ac"] },
    ] }),
    draft({ kind: "workspace.prepared", workspace: "/workspace/afk/.worktrees/workflow-redesign", branch: "afk/workflow-redesign", baseBranch: "main" }),
    draft({ kind: "step.started", stepId: "prepare-workspace", phase: "implementation" }),
    draft({ kind: "step.completed", stepId: "prepare-workspace", outcome: "succeeded" }),
    draft({ kind: "step.started", stepId: "implement", phase: "implementation" }),
    draft({ kind: "step.completed", stepId: "implement", outcome: "succeeded" }),
    draft({ kind: "step.started", stepId: "verify-ac", phase: "verification" }),
    draft({ kind: "step.completed", stepId: "verify-ac", outcome: "failed" }),
  ]);
  await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
  await page.getByRole("radio", { name: "运行实例", exact: true }).click();
  const instance = page.getByRole("region", { name: "工作流实例" });
  await expect(instance.getByLabel("本次工作流快照")).toContainText("依赖 prepare-workspace");
  await expect(instance.getByLabel("本次工作流快照").locator("li.failed")).toContainText("verify-ac");
  await expect(instance.getByRole("radio", { name: "进行中", exact: true })).toHaveCSS("white-space", "nowrap");
  await expect(instance.locator(".workflow-instance-snapshot > header")).toContainText("2 / 4");
  await instance.getByRole("searchbox", { name: "搜索工作流实例" }).fill("no-such-run");
  await expect(instance.getByLabel("选择工作流实例")).toContainText("没有匹配");
  await expect(instance.getByLabel("工作流实例详情")).toContainText(runId);
  await instance.getByRole("searchbox", { name: "搜索工作流实例" }).fill("");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.afkTheme = theme; }, theme);
    if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/workflow-instance-${theme}.png` });
  }
  await instance.getByRole("radio", { name: /^运行日志/ }).click();
  const log = instance.getByRole("region", { name: "运行日志", exact: true });
  await log.getByRole("radio", { name: /^异常/ }).click();
  await expect(log.locator(".run-timeline > li")).toHaveCount(1);
  await expect(log.locator(".run-timeline")).toContainText("verify-ac");
  await log.getByRole("searchbox", { name: "搜索运行日志" }).fill("implement");
  await expect(log).toContainText("没有匹配的运行日志");
  await log.getByRole("searchbox", { name: "搜索运行日志" }).fill("");
  await log.getByRole("radio", { name: /^全部/ }).click();
  const workspaceEvent = log.locator(".run-log-event").filter({ hasText: "任务空间就绪" });
  await workspaceEvent.locator("summary").click();
  await expect(workspaceEvent.getByText("/workspace/afk/.worktrees/workflow-redesign", { exact: true })).toBeVisible();
  await expect(log.locator(".run-timeline > li")).toHaveCount(10);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.afkTheme = theme; }, theme);
    if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/workflow-run-logs-${theme}.png` });
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  expect(await instance.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const detail = instance.getByLabel("工作流实例详情");
  expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const button of await instance.getByRole("radiogroup", { name: "实例筛选" }).getByRole("radio").all()) {
    expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/workflow-run-logs-compact.png` });
});
