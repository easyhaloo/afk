import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunTimelineSection, RunTimelineView } from "../src/features/run-center/RunTimelineView.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : text(child as ReactTestInstance)).join("");
}

const detail = {
  runId: "afk-158",
  workItemId: "github:easyhaloo/afk#158",
  integrityValid: true,
  status: "running" as const,
  entries: [
    { sequence: 1, occurredAt: "2026-09-29T00:00:00.000Z", kind: "run.started" },
    { sequence: 2, occurredAt: "2026-09-29T00:00:01.000Z", kind: "workspace.prepared", workspacePath: "/tmp/ws", workspaceBranch: "afk/task" },
    { sequence: 3, occurredAt: "2026-09-29T00:00:02.000Z", kind: "qa.failed", outcome: "failed" as const, failureSummary: "AC-2 未满足" },
  ],
};

type Load = (runId: string, workItemId: string) => Promise<typeof detail>;

describe("run timeline view", () => {
  it("loads only the expanded native details section and stops on collapse", async () => {
    const load = vi.fn<Load>(async () => detail);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineSection, { load, runId: detail.runId, workItemId: detail.workItemId, running: true })); });
    expect(load).not.toHaveBeenCalled();
    await act(async () => { const target = { open: true }; renderer.root.findByProps({ className: "work-item-run-timeline" }).props.onToggle({ target, currentTarget: target }); });
    expect(load).toHaveBeenCalledOnce();
    await act(async () => { const target = { open: false }; renderer.root.findByProps({ className: "work-item-run-timeline" }).props.onToggle({ target, currentTarget: target }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(load).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders recorded events with sequence #N, kind label and workspace path", async () => {
    const load = vi.fn<Load>(async () => detail);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: true, running: false })); });
    const timeline = renderer.root.findByProps({ className: "run-timeline" });
    expect(timeline.props["aria-label"]).toContain("afk-158");
    expect(text(timeline)).toContain("#1");
    expect(text(timeline)).toContain("#2");
    expect(text(timeline)).toContain("#3");
    expect(text(timeline)).toContain("运行开始");
    expect(text(timeline)).toContain("/tmp/ws");
    expect(text(timeline)).toContain("afk/task");
    expect(text(timeline)).toContain("AC-2 未满足");
    expect(text(renderer.root)).toContain("本次运行未记录工作流快照");
  });

  it("does not load while collapsed", async () => {
    const load = vi.fn<Load>(async () => detail);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: false, running: false })); });
    expect(load).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("combines failure filtering with search and keeps unknown event kinds readable", async () => {
    const load = vi.fn(async () => ({ ...detail, entries: [...detail.entries, { sequence: 4, occurredAt: "2026-09-29T00:00:03.000Z", kind: "retro.requested", reason: "review queued" }] }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: detail.runId, workItemId: detail.workItemId, expanded: true, running: false })); });
    const timeline = () => text(renderer.root.findByProps({ className: "run-timeline" }));
    expect(timeline()).toContain("retro.requested");
    await act(async () => { renderer.root.findAllByProps({ role: "radio" }).find(button => text(button).startsWith("异常"))!.props.onClick(); });
    expect(timeline()).toContain("AC-2 未满足");
    expect(timeline()).not.toContain("运行开始");
    await act(async () => { renderer.root.findByProps({ type: "search" }).props.onChange({ target: { value: "不存在的步骤" } }); });
    expect(text(renderer.root)).toContain("没有匹配的运行日志");
    await act(async () => { renderer.root.findByProps({ type: "search" }).props.onChange({ target: { value: "AC-2" } }); });
    expect(timeline()).toContain("#3");
    expect(load).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it("does not render entries from an invalid audit stream", async () => {
    const load = vi.fn(async () => ({ ...detail, integrityValid: false, integrityReason: "integrity_mismatch" }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: detail.runId, workItemId: detail.workItemId, expanded: true, running: false })); });
    expect(text(renderer.root)).toContain("integrity_mismatch");
    expect(renderer.root.findAllByProps({ className: "run-timeline" })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("polls every 5s while running and keeps the last loaded data during refresh", async () => {
    const nextDetail = { ...detail, entries: [...detail.entries, { sequence: 4, occurredAt: "2026-09-29T00:00:03.000Z", kind: "step.started", stepId: "qa", phase: "verification" }] };
    let call = 0;
    const load = vi.fn<Load>(async () => { call += 1; return call === 1 ? detail : nextDetail; });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: true, running: true })); });
    expect(text(renderer.root.findByProps({ className: "run-timeline" }))).not.toContain("#4");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(text(renderer.root.findByProps({ className: "run-timeline" }))).toContain("#4");
    expect(text(renderer.root.findByProps({ className: "run-timeline" }))).toContain("#1");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(3);
    act(() => renderer.unmount());
  });

  it("stops polling after unmount", async () => {
    const load = vi.fn<Load>(async () => detail);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: true, running: true })); });
    expect(load).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not reload across parent re-renders that pass a fresh load closure", async () => {
    const load = vi.fn<Load>(async () => detail);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: true, running: false })); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(createElement(RunTimelineView, { load: (id: string, itemId: string) => load(id, itemId), runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: true, running: false }));
    });
    expect(load).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it("ignores a stale response after the run switches", async () => {
    const stale = { ...detail, runId: "afk-old", entries: [{ ...detail.entries[0], sequence: 91 }] };
    const fresh = { ...detail, runId: "afk-new", entries: [{ ...detail.entries[0], sequence: 101 }] };
    const load = vi.fn<Load>(async runId => {
      if (runId === "afk-old") throw new Error("stale response should be ignored for old run");
      return { ...fresh, runId };
    });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-old", workItemId: "github:easyhaloo/afk#158", expanded: true, running: false })); });
    await act(async () => { renderer.update(createElement(RunTimelineView, { load, runId: "afk-new", workItemId: "github:easyhaloo/afk#158", expanded: true, running: false })); });
    const timeline = renderer.root.findByProps({ className: "run-timeline" });
    expect(timeline.props["aria-label"]).toContain("afk-new");
    expect(timeline.props["aria-label"]).not.toContain("afk-old");
    expect(text(timeline)).not.toContain("#91");
    act(() => renderer.unmount());
  });

  it("shows an honest message when the stream cannot be replayed", async () => {
    const load = vi.fn<Load>(async () => { throw new Error("run 'afk-158' event stream is not replayable: integrity_mismatch"); });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: true, running: false })); });
    expect(text(renderer.root.findByProps({ className: "run-timeline-missing" }))).toContain("不会生成替代内容");
    expect(text(renderer.root.findByProps({ className: "run-timeline-missing" }))).toContain("integrity_mismatch");
    act(() => renderer.unmount());
  });

  it("reports an empty stream instead of inventing entries", async () => {
    const load = vi.fn<Load>(async () => ({ ...detail, entries: [] }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(RunTimelineView, { load, runId: "afk-158", workItemId: "github:easyhaloo/afk#158", expanded: true, running: false })); });
    expect(text(renderer.root.findByProps({ className: "run-timeline-missing" }))).toContain("没有已记录的事件");
    act(() => renderer.unmount());
  });
});
