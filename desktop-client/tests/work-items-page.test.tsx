import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkItemsPage } from "../src/features/work-items/WorkItemsPage";
import type { WorkItemInventoryResult } from "../shared/backlog-contract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textContent(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : textContent(child as ReactTestInstance)).join("");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function selectProvider(renderer: ReturnType<typeof create>, name: string) {
  renderer.root.findByProps({ "aria-label": "选择 Provider" }).props.onChange({ currentTarget: { value: name } });
}

const result: WorkItemInventoryResult = {
  items: [
    { id: "github:acme/api#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/api", name: "api" }, title: "API issue", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "afk/backlog-1", providerRef: "github:acme/api#1" },
    { id: "github:acme/web#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/web", name: "web" }, title: "Web issue", managed: false, executionEligible: false, state: "ready", executionMode: "hitl", dependsOn: [], tags: [], branchName: "afk/backlog-1", providerRef: "github:acme/web#1" },
  ],
  projects: [
    { platform: "github", projectKey: "acme/api", name: "api" },
    { platform: "github", projectKey: "acme/web", name: "web" },
  ],
  diagnostics: [],
  complete: true,
};

describe("WorkItemsPage", () => {
  it("loads globally without a workspace and keeps same-number issues distinct", async () => {
    const list = vi.fn(async () => result);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledWith(undefined);
    const rows = renderer!.root.findAllByProps({ className: "backlog-row work-item-row" });
    expect(rows).toHaveLength(2);
    expect(textContent(rows[0])).toContain("acme/api");
    expect(textContent(rows[1])).toContain("acme/web");
    expect(textContent(rows[0])).toContain("#1");
    expect(textContent(rows[1])).toContain("#1");
    act(() => renderer!.unmount());
  });

  it("shows successful rows together with partial diagnostics", async () => {
    const partial = { ...result, complete: false, diagnostics: [{ platform: "gitlab" as const, projectKey: "corp/tools", code: "provider", message: "request failed", retryable: true }] };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => partial) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(2);
    expect(textContent(renderer!.root.findByProps({ className: "work-item-diagnostics" }))).toContain("corp/tools");
    act(() => renderer!.unmount());
  });

  it("forces a provider reload when the user clicks refresh", async () => {
    const list = vi.fn(async () => result);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "刷新工作项" }).props.onClick();
      await Promise.resolve();
    });

    expect(list).toHaveBeenNthCalledWith(1, undefined);
    expect(list).toHaveBeenNthCalledWith(2, undefined, true);
    act(() => renderer!.unmount());
  });

  it("does not replace the selected provider's items with a late result", async () => {
    const allRequest = deferred<WorkItemInventoryResult>();
    const gitlabItem = { ...result.items[0], id: "gitlab:corp/api#1", project: { platform: "gitlab" as const, projectKey: "corp/api", name: "api" }, providerRef: "gitlab:corp/api#1" };
    const gitlabResult: WorkItemInventoryResult = { items: [gitlabItem], projects: [gitlabItem.project], diagnostics: [], complete: true };
    const list = vi.fn((options?: { platform?: string }) => options?.platform === "gitlab" ? Promise.resolve(gitlabResult) : allRequest.promise);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { selectProvider(renderer!, "gitlab"); });
    expect(textContent(renderer!.root.findByProps({ className: "backlog-list" }))).toContain("corp/api");

    await act(async () => { allRequest.resolve(result); });

    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(1);
    expect(textContent(renderer!.root.findByProps({ className: "backlog-list" }))).toContain("corp/api");
    act(() => renderer!.unmount());
  });

  it("does not show an obsolete request error after switching providers", async () => {
    const allRequest = deferred<WorkItemInventoryResult>();
    const list = vi.fn((options?: { platform?: string }) => options?.platform === "gitlab"
      ? Promise.resolve({ ...result, items: [], projects: [] })
      : allRequest.promise);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { selectProvider(renderer!, "gitlab"); });
    await act(async () => { allRequest.reject(new Error("old GitHub failure")); });

    expect(renderer!.root.findAllByProps({ className: "backlog-alert error" })).toHaveLength(0);
    act(() => renderer!.unmount());
  });

  it("shows a bounded batch while searching the complete inventory", async () => {
    const items = Array.from({ length: 205 }, (_, index) => ({
      ...result.items[0],
      id: `github:acme/${index === 204 ? "web" : "api"}#${index + 1}`,
      issueNumber: index + 1,
      title: `Issue ${index + 1}`,
      project: index === 204 ? result.projects[1] : result.projects[0],
      providerRef: `github:acme/${index === 204 ? "web" : "api"}#${index + 1}`,
    }));
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => ({ ...result, items })) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });

    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(50);
    await act(async () => { renderer!.root.findByProps({ "aria-label": "显示更多工作项" }).props.onClick(); });
    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(100);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "搜索工作项" }).props.onChange({ target: { value: "Issue 205" } }); });
    const rows = renderer!.root.findAllByProps({ className: "backlog-row work-item-row" });
    expect(rows).toHaveLength(1);
    expect(textContent(rows[0])).toContain("Issue 205");
    expect(renderer!.root.findAllByProps({ "aria-label": "显示更多工作项" })).toHaveLength(0);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "搜索工作项" }).props.onChange({ target: { value: "Issue" } }); });
    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(50);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "选择仓库" }).props.onChange({ currentTarget: { value: "github:acme/web" } }); });
    const projectRows = renderer!.root.findAllByProps({ className: "backlog-row work-item-row" });
    expect(projectRows).toHaveLength(1);
    expect(textContent(projectRows[0])).toContain("Issue 205");
    act(() => renderer!.unmount());
  });
});
