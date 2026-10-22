import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkItemsPage } from "../src/features/work-items/WorkItemsPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : text(child as ReactTestInstance)).join("");
}

describe("work item audit history", () => {
  it.each([
    { workflow: undefined, validTime: true, copyOutcome: "success" },
    { workflow: "issue-implementation", validTime: true, copyOutcome: "false" },
    { workflow: "  ", validTime: true, copyOutcome: "error" },
    { workflow: undefined, validTime: false, copyOutcome: "success" },
  ])("selects launch metadata separately from an audit attempt with the same ID ($workflow, $validTime)", async ({ workflow, validTime, copyOutcome }) => {
    const workItemId = "github:easyhaloo/afk#158";
    const runId = "desktop-2954a4d0-d193-4a39-95dc-e2b61cb69305";
    const startedAt = validTime ? new Date(2026, 9, 19, 20, 16, 17).toISOString() : "invalid-time";
    const copyText = vi.fn(async () => {
      if (copyOutcome === "error") throw new Error("clipboard unavailable");
      return copyOutcome === "success";
    });
    const item = { id: workItemId, issueNumber: 158, project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" },
      title: "Task", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "task", providerRef: workItemId,
      runs: [{ id: runId, status: workflow === "issue-implementation" ? "failed" : "completed", startedAt, workflow, workspacePath: "/old", error: "历史进程退出" }] };
    vi.stubGlobal("window", { afkDesktop: { copyText, workItems: {
      list: vi.fn(async () => ({ items: [item], projects: [], diagnostics: [], complete: true })),
      executions: vi.fn(async () => ({ executions: [{ runId, workItemId, profileId: "default", attempt: 1, status: "running", sequence: 1, terminal: false, ...(validTime ? { startedAt } : {}) }] })),
      start: vi.fn(),
    } } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { renderer.root.findAllByType("button").find(node => text(node).includes("运行记录"))!.props.onClick(); });
    expect(renderer.root.findAllByProps({ className: "work-item-run-card" })).toHaveLength(2);
    const launchCard = renderer.root.findAllByProps({ className: "work-item-run-card" })[1];
    const auditCard = renderer.root.findAllByProps({ className: "work-item-run-card" })[0];
    expect(auditCard.props["data-selected"]).toBe(true);
    expect(launchCard.props["data-selected"]).toBe(false);
    expect(text(renderer.root.findByProps({ "aria-label": "运行详情" }))).toContain("运行审计");
    expect(launchCard.findAllByType("details")).toHaveLength(0);
    expect(auditCard.findAllByType("details")).toHaveLength(0);
    expect(text(launchCard)).not.toContain("默认工作流");
    expect(text(launchCard)).not.toContain(runId);
    expect(text(auditCard)).not.toContain(runId);
    if (workflow === "issue-implementation") expect(text(launchCard.findByProps({ className: "work-item-run-summary failed" }))).toBe("历史进程退出");
    else expect(text(launchCard)).not.toContain("历史进程退出");
    await act(async () => { launchCard.findByType("button").props.onClick({ currentTarget: null }); });
    expect(launchCard.props["data-selected"]).toBe(true);
    expect(auditCard.props["data-selected"]).toBe(false);
    const inspector = renderer.root.findByProps({ "aria-label": "运行详情" });
    expect(text(inspector)).toContain("启动记录");
    expect(text(inspector)).not.toContain("运行审计");
    if (workflow?.trim()) expect(text(inspector)).toContain(workflow);
    else expect(text(inspector)).not.toContain("工作流");
    const identity = inspector.findByProps({ className: "work-item-run-identity" });
    expect(text(identity)).toContain("2954a4d0");
    expect(identity.findByType("code").props.title).toBe(runId);
    await act(async () => { await inspector.findByProps({ "aria-label": `复制运行 ${runId} 的完整编号` }).props.onClick(); });
    expect(copyText).toHaveBeenCalledWith(runId);
    expect(text(inspector.findByProps({ role: "status" }))).toBe(copyOutcome === "success" ? "已复制" : "复制失败，请重试");
    await act(async () => { auditCard.findByType("button").props.onClick({ currentTarget: null }); });
    expect(text(renderer.root.findByProps({ "aria-label": "运行详情" }))).toContain("运行审计");
    expect(renderer.root.findByProps({ "aria-label": "运行详情" }).findAllByProps({ role: "status" })).toHaveLength(0);
    if (validTime) {
      const timestamp = launchCard.findByType("time");
      expect(text(timestamp)).toBe("2026/10/19 20:16:17");
      expect(timestamp.props.dateTime).toBe(startedAt);
      expect(timestamp.props.title).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(text(launchCard.findByType("b"))).toBe("2026/10/19 20:16:17");
      expect(text(auditCard.findByType("b"))).toBe("2026/10/19 20:16:17");
    } else {
      expect(text(launchCard)).toContain("开始时间不可用");
      expect(text(launchCard)).not.toContain("Invalid Date");
      expect(text(auditCard.findByType("b"))).toBe("开始时间未记录");
    }
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });
  it("shows the application run phase and human gate without inventing PR information", async () => {
    const executions = vi.fn(async () => ({ executions: [{
      runId: "afk-158", workItemId: "github:easyhaloo/afk#158",
      profileId: "default", attempt: 1, status: "awaiting_human", phase: "verification", sequence: 3, terminal: false,
    }] }));
    vi.stubGlobal("window", { afkDesktop: { workItems: {
      list: vi.fn(async () => ({ items: [{ id: "github:easyhaloo/afk#158", issueNumber: 158, project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" }, title: "Task", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "task", providerRef: "github:easyhaloo/afk#158" }], projects: [], diagnostics: [], complete: true })),
      executions, start: vi.fn(),
    } } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { renderer.root.findAllByType("button").find(node => text(node).includes("运行记录"))!.props.onClick(); });
    expect(executions).toHaveBeenCalledWith({ workItemId: "github:easyhaloo/afk#158", limit: 100 });
    expect(text(renderer.root.findByProps({ className: "work-item-detail-body" }))).toContain("等待人工处理");
    expect(text(renderer.root.findByProps({ className: "work-item-detail-body" }))).toContain("验证");
    expect(renderer.root.findAllByProps({ "aria-label": "打开 PR #159" })).toHaveLength(0);
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("loads the next audited page without dropping the first page", async () => {
    const workItemId = "github:easyhaloo/afk#158";
    const item = { id: workItemId, issueNumber: 158, project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" },
      title: "Task", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "task", providerRef: workItemId };
    const run = (runId: string) => ({ runId, workItemId, profileId: "default", attempt: 1,
      status: "running", sequence: 2, terminal: false });
    const executions = vi.fn(async (options: { since?: string }) => options.since
      ? { executions: [run("older")] }
      : { executions: [run("newer")], nextCursor: "newer" });
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => ({ items: [item], projects: [], diagnostics: [], complete: true })), executions, start: vi.fn() }, openExternal: vi.fn() } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { renderer.root.findAllByType("button").find(node => text(node).includes("运行记录"))!.props.onClick(); });
    await act(async () => { renderer.root.findAllByType("button").find(node => text(node) === "查看更多运行记录")!.props.onClick(); });
    expect(executions).toHaveBeenCalledWith({ workItemId, limit: 100, since: "newer" });
    const newer = renderer.root.findByProps({ "data-run-id": "newer" });
    const older = renderer.root.findByProps({ "data-run-id": "older" });
    expect(newer.props["data-selected"]).toBe(true);
    await act(async () => { older.findByType("button").props.onClick({ currentTarget: null }); });
    expect(older.props["data-selected"]).toBe(true);
    expect(text(renderer.root.findByProps({ "aria-label": "运行详情" }))).toContain("older");
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("orders both record sources by start time and preserves the selected attempt when polling adds a newer run", async () => {
    vi.useFakeTimers();
    const workItemId = "github:easyhaloo/afk#158";
    const item = { id: workItemId, issueNumber: 158, project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" }, title: "Task", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "task", providerRef: workItemId,
      runs: [{ id: "new-launch", status: "failed", startedAt: "2026-10-19T12:30:00Z" }, { id: "unknown-start", status: "failed" }] };
    const audit = { runId: "older-audit", workItemId, profileId: "default", attempt: 1, status: "running", sequence: 1, terminal: false, startedAt: "2026-10-19T12:00:00Z" };
    const executions = vi.fn().mockResolvedValueOnce({ executions: [audit] }).mockResolvedValue({ executions: [{ ...audit, runId: "newest-audit", startedAt: "2026-10-19T13:00:00Z" }, { ...audit, sequence: 2 }] });
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => ({ items: [item], projects: [], diagnostics: [], complete: true })), executions } } });
    let renderer!: ReturnType<typeof create>;
    try {
      await act(async () => { renderer = create(createElement(WorkItemsPage)); });
      await act(async () => { renderer.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
      await act(async () => { renderer.root.findAllByType("button").find(node => text(node).includes("运行记录"))!.props.onClick(); });
      const cards = () => renderer.root.findAllByProps({ className: "work-item-run-card" });
      expect(cards().map(node => node.props["data-run-id"])).toEqual(["new-launch", "older-audit", "unknown-start"]);
      expect(cards()[0].props["data-selected"]).toBe(true);
      await act(async () => { cards()[1].findByType("button").props.onClick({ currentTarget: null }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(cards().map(node => node.props["data-run-id"])).toEqual(["newest-audit", "new-launch", "older-audit", "unknown-start"]);
      expect(cards()[2].props["data-selected"]).toBe(true);
      expect(text(renderer.root.findByProps({ "aria-label": "运行详情" }))).toContain("事件序号 2");
    } finally {
      if (renderer) act(() => renderer.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
