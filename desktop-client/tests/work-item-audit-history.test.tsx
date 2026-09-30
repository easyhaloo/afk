import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkItemsPage } from "../src/features/work-items/WorkItemsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : text(child as ReactTestInstance)).join("");
}

describe("work item audit history", () => {
  it("keeps an old row when only its ID matches an audit attempt", async () => {
    const workItemId = "github:easyhaloo/afk#158";
    const item = { id: workItemId, issueNumber: 158, project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" },
      title: "Task", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "task", providerRef: workItemId,
      runs: [{ id: "shared", status: "completed", startedAt: "2026-09-25T00:00:00Z", workspacePath: "/old" }] };
    vi.stubGlobal("window", { afkDesktop: { workItems: {
      list: vi.fn(async () => ({ items: [item], projects: [], diagnostics: [], complete: true })),
      executions: vi.fn(async () => ({ executions: [{ runId: "shared", workItemId, profileId: "default", attempt: 1, status: "running", sequence: 1, terminal: false }] })),
      start: vi.fn(),
    } } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { renderer.root.findAllByType("button").find(node => text(node).includes("运行记录"))!.props.onClick(); });
    expect(renderer.root.findAllByProps({ className: "work-item-run-card" })).toHaveLength(2);
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
    expect(text(renderer.root.findByProps({ className: "work-item-detail-body" }))).toContain("newer");
    expect(text(renderer.root.findByProps({ className: "work-item-detail-body" }))).toContain("older");
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });
});
