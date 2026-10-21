import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRunDetail, ExecutionSummary } from "../shared/execution-contract";
import { WorkflowInstancesPage } from "../src/features/workflows/WorkflowInstancesPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : text(child as ReactTestInstance)).join("");
}

const executions: ExecutionSummary[] = [
  { runId: "run-one", workItemId: "github:acme/api#1", profileId: "default", attempt: 1, status: "succeeded", sequence: 4, terminal: true },
  { runId: "run-two", workItemId: "github:acme/api#2", profileId: "default", attempt: 2, status: "failed", sequence: 3, terminal: true },
];
const detail: ExecutionRunDetail = {
  ...executions[0], integrityValid: true,
  workflow: { name: "recorded-workflow", version: 1, recordedAt: "2026-10-19T00:00:00Z", steps: [
    { id: "implement", kind: "agent", dependsOn: [], provider: "codex", status: "succeeded" },
    { id: "verify", kind: "agent", dependsOn: ["implement"], provider: "opencode", status: "pending" },
  ] },
  entries: [{ sequence: 1, occurredAt: "2026-10-19T00:00:00Z", kind: "step.completed", stepId: "implement", outcome: "succeeded" }],
};
const actions = { onSelect: vi.fn(), onRun: vi.fn(), onWorkItem: vi.fn(), onEnvironment: vi.fn(), onAttach: vi.fn(), onDefinition: vi.fn() };

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("workflow instances", () => {
  it("searches instances and shows recorded steps and logs without reloading the snapshot", async () => {
    const load = vi.fn(async () => detail);
    vi.stubGlobal("window", { afkDesktop: { workItems: { executionRunDetail: load } } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkflowInstancesPage, { executions, ...actions })); });
    expect(text(renderer.root.findByProps({ "aria-label": "本次工作流快照" }))).toContain("implement");
    expect(text(renderer.root.findByProps({ "aria-label": "本次工作流快照" }))).toContain("依赖 implement");
    await act(async () => { renderer.root.findByProps({ "aria-label": "搜索工作流实例" }).props.onChange({ target: { value: "run-two" } }); });
    const list = renderer.root.findByProps({ "aria-label": "选择工作流实例" });
    expect(text(list)).toContain("run-two");
    expect(text(list)).not.toContain("run-one");
    await act(async () => { renderer.root.findAllByProps({ role: "radio" }).find(button => text(button).startsWith("运行日志"))!.props.onClick(); });
    expect(text(renderer.root.findByProps({ className: "run-timeline" }))).toContain("implement");
    expect(load).toHaveBeenCalledOnce();
    await act(async () => { renderer.root.findByProps({ "aria-label": "查看关联工作项" }).props.onClick(); });
    expect(actions.onWorkItem).toHaveBeenCalledWith(detail.workItemId);
    act(() => renderer.unmount());
  });

  it("keeps a selected historical run visible and never replaces its missing snapshot", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { executionRunDetail: vi.fn(async () => ({ ...detail, runId: "historical", workflow: undefined })) } } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkflowInstancesPage, { executions, selection: { runId: "historical", workItemId: detail.workItemId }, ...actions })); });
    expect(text(renderer.root.findByProps({ "aria-label": "选择工作流实例" }))).toContain("historical");
    expect(text(renderer.root)).toContain("本次运行没有工作流快照");
    expect(renderer.root.findByProps({ "aria-label": "查看当前工作流定义" }).props.disabled).toBe(true);
    act(() => renderer.unmount());
  });
});
