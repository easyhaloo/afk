import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { BacklogPage } from "../src/features/backlog/BacklogPage";
import { resetBacklogCache } from "../src/features/backlog/backlog-cache";
import type { BacklogItem } from "../shared/backlog-contract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { document?: unknown }).document = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  activeElement: null,
};

const items: BacklogItem[] = [
  { id: "1", workItemId: "github:owner/repo#101", title: "Ready", dependsOn: [], state: "ready", executionMode: "afk", tags: ["urgent"], branchName: "afk/1", providerRef: "github:owner/repo#101" },
  { id: "2", workItemId: "gitlab:group/repo#202", title: "Blocked", dependsOn: ["1"], state: "blocked", executionMode: "hitl", tags: [], branchName: "afk/2", providerRef: "gitlab:group/repo#202" },
  { id: "3", title: "Legacy", dependsOn: [], state: "rework", executionMode: "afk", tags: [], branchName: "afk/3", providerRef: "stub:3" },
  { id: "4", workItemId: "github:owner/repo#104", title: "Running", dependsOn: [], state: "in_progress", executionMode: "afk", tags: [], branchName: "afk/4", providerRef: "stub:4" },
  { id: "5", workItemId: "github:owner/repo#105", title: "Merge", dependsOn: [], state: "merge_ready", executionMode: "hitl", tags: [], branchName: "afk/5", providerRef: "stub:5" },
  { id: "6", title: "Stale", dependsOn: [], state: "in_progress", executionMode: "afk", tags: [], branchName: "afk/6", providerRef: "stub:6" },
];

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textContent(child as ReactTestInstance)).join("");
}

async function renderPage(onOpenWorkItem?: (workItemId: string) => void) {
  const backlog = {
    list: vi.fn(async () => items),
    runs: vi.fn(async () => [{ id: "legacy-run", backlogId: "3", status: "completed", startedAt: "2026-09-01T00:00:00Z" }, { id: "running-run", backlogId: "4", status: "running", pid: 1234, startedAt: "2026-09-01T00:00:00Z" }]),
    summary: vi.fn(async (_workspace: string, id: string) => ({ backlogId: id, backlog: items.find((item) => item.id === id)!, ...(id === "6" ? { runtime: { runId: "stale-run", status: "stale", phase: "implementing", heartbeatAt: "2026-09-01T00:00:00Z" } } : {}) })),
    start: vi.fn(), retry: vi.fn(), stop: vi.fn(), recover: vi.fn(), confirmMerge: vi.fn(),
  };
  vi.stubGlobal("window", { afkDesktop: { backlog, openExternal: vi.fn() } });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(BacklogPage, { workspace: "/repo", onOpenWorkItem }));
    for (let iteration = 0; iteration < 10; iteration += 1) await Promise.resolve();
  });
  return { backlog, renderer, rows: renderer.root.findAllByProps({ className: "backlog-row" }) };
}

beforeEach(() => resetBacklogCache());
afterEach(() => { vi.unstubAllGlobals(); resetBacklogCache(); });

describe("Backlog planning navigation", () => {
  it("routes ready and retry candidates by canonical workItemId without launching another run", async () => {
    const onOpenWorkItem = vi.fn();
    const { backlog, renderer, rows } = await renderPage(onOpenWorkItem);

    for (const row of rows.slice(0, 2)) {
      const button = row.findByProps({ className: "backlog-run-button" });
      expect(button.props["aria-label"]).toBe("在工作项中执行");
      expect(button.props.disabled).toBe(false);
      await act(async () => { button.props.onClick({ stopPropagation: vi.fn() }); });
    }

    expect(onOpenWorkItem.mock.calls).toEqual([["github:owner/repo#101"], ["gitlab:group/repo#202"]]);
    expect(renderer.root.findAllByProps({ className: "backlog-launch-confirm" })).toHaveLength(0);
    expect(backlog.start).not.toHaveBeenCalled();
    expect(backlog.retry).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("disables execution navigation with a visible diagnostic for a legacy item without workItemId", async () => {
    const onOpenWorkItem = vi.fn();
    const { backlog, renderer, rows } = await renderPage(onOpenWorkItem);
    const legacyRow = rows[2];
    const button = legacyRow.findByProps({ className: "backlog-run-button" });

    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toContain("workItemId");
    expect(textContent(legacyRow)).toContain("workItemId");
    expect(textContent(legacyRow)).toContain("运行状态：进程已退出，QA 未确认");
    await act(async () => { legacyRow.props.onClick(); await Promise.resolve(); });
    expect(backlog.summary).toHaveBeenCalledWith("/repo", "3");
    expect(onOpenWorkItem).not.toHaveBeenCalled();
    expect(backlog.start).not.toHaveBeenCalled();
    expect(backlog.retry).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("disables the work item link when no navigation callback is integrated", async () => {
    const { renderer, rows } = await renderPage();
    const button = rows[0].findByProps({ className: "backlog-run-button" });

    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toContain("导航");
    act(() => renderer.unmount());
  });

  it("retains stop, recovery, and merge confirmation for existing lifecycle states", async () => {
    const onOpenWorkItem = vi.fn();
    const { backlog, renderer, rows } = await renderPage(onOpenWorkItem);
    const cases = [
      { row: rows[3], label: "停止并转人工", method: backlog.stop, id: "4" },
      { row: rows[4], label: "确认合并", method: backlog.confirmMerge, id: "5" },
      { row: rows[5], label: "标记阻塞并恢复", method: backlog.recover, id: "6" },
    ];
    for (const { row, label, method, id } of cases) {
      method.mockResolvedValueOnce({ backlogId: id, backlog: items.find((item) => item.id === id)! });
      const button = row.findByProps({ className: "backlog-run-button" });
      expect(button.props["aria-label"]).toBe(label);
      expect(button.props.disabled).toBe(false);
      await act(async () => { button.props.onClick({ stopPropagation: vi.fn() }); await Promise.resolve(); });
      expect(method).toHaveBeenCalledWith("/repo", id);
    }

    expect(onOpenWorkItem).not.toHaveBeenCalled();
    expect(backlog.start).not.toHaveBeenCalled();
    expect(backlog.retry).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
