import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkItemsPage } from "../src/features/work-items/WorkItemsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("work item navigation", () => {
  it("opens the exact provider-qualified item selected from Backlog", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: {
      list: vi.fn(async () => ({ items: [
        { id: "github:other/repo#158", issueNumber: 158, project: { platform: "github", projectKey: "other/repo", name: "repo" }, title: "Other", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "other", providerRef: "github:other/repo#158" },
        { id: "github:easyhaloo/afk#158", issueNumber: 158, project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" }, title: "Target", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "target", providerRef: "github:easyhaloo/afk#158" },
      ], projects: [], diagnostics: [], complete: true })),
      start: vi.fn(),
    }, openExternal: vi.fn() } });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(WorkItemsPage, { focusWorkItemId: "github:easyhaloo/afk#158" })); });
    expect(renderer.root.findByProps({ "aria-label": "工作项 github:easyhaloo/afk#158" })).toBeDefined();
    expect(renderer.root.findAllByProps({ "aria-label": "工作项 github:other/repo#158" })).toHaveLength(0);
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });
});
