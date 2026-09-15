import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { SelectMenu } from "../src/components/SelectMenu";
import { WorkflowStudioInspector } from "../src/main";

describe("SelectMenu", () => {
  it("adds an explicit centered trigger variant without changing the default class", () => {
    const props = {
      label: "选择 Provider",
      value: "auto",
      options: [{ value: "auto", label: "自动探测" }],
      onChange: vi.fn(),
    };
    let defaultRenderer!: ReturnType<typeof create>;
    let centeredRenderer!: ReturnType<typeof create>;

    act(() => {
      defaultRenderer = create(createElement(SelectMenu, props));
      centeredRenderer = create(createElement(SelectMenu, { ...props, triggerLayout: "center" }));
    });

    expect(defaultRenderer.root.findByProps({ className: "select-menu" })).toBeTruthy();
    expect(centeredRenderer.root.findByProps({ className: "select-menu centered-trigger" })).toBeTruthy();
  });

  it("opens a listbox and selects an option without a native select", () => {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(SelectMenu, {
        label: "筛选状态",
        value: "all",
        options: [{ value: "all", label: "全部状态" }, { value: "done", label: "已完成" }],
        onChange,
      }));
    });

    act(() => { renderer.root.findByProps({ className: "select-menu-trigger" }).props.onClick(); });
    expect(renderer.root.findByProps({ role: "listbox" })).toBeTruthy();
    act(() => { renderer.root.findAllByProps({ role: "option" })[1].props.onClick(); });
    expect(onChange).toHaveBeenCalledWith("done");
  });

  it("uses the shared select menu for workflow inspector option fields", () => {
    const onTemplatePatch = vi.fn();
    const template: CanvasTemplateNode = {
      id: "agent-1",
      template: "agent",
      label: "实现节点",
      description: "执行实现",
      prompt: "实现任务",
      provider: "claude-code",
      x: 100,
      y: 100,
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<WorkflowStudioInspector
        node={{ id: "agent-1", number: "A1", title: "实现节点", caption: "执行实现", state: "ready", x: 100, y: 100, custom: template }}
        workflow={{
          configPath: "/tmp/config.yml",
          source: "project",
          agentDefault: "codex",
          tmuxSession: "afk",
          targetBranch: "main",
          baseBranch: "main",
          maxRetries: 1,
          hardTimeoutMs: 1000,
          completionTimeoutMs: 1000,
          contextThreshold: 100,
          goalBudget: 1000,
          codex: { transport: "auto", auth: "auto", provider: "openai", startupTimeoutMs: 1000 },
          canvasNodes: [template],
        }}
        loop={{ state: "stopped", implement: { active: 0, ids: [] }, qa: { active: null, queue: [] }, totals: { completed: 0, failed: 0 } }}
        runs={[]}
        onPatch={vi.fn()}
        onCodexPatch={vi.fn()}
        onTemplatePatch={onTemplatePatch}
        onDeleteTemplate={vi.fn()}
        dirty={false}
        saving={false}
        error={null}
        onSave={vi.fn(async () => undefined)}
        onReset={vi.fn()}
        onCollapse={vi.fn()}
      />);
    });

    expect(renderer.root.findAllByProps({ className: "select-menu" })).toHaveLength(1);
    expect(renderer.root.findAllByType("select")).toHaveLength(0);
    act(() => {
      renderer.root.findByProps({ className: "select-menu-trigger" }).props.onClick();
    });
    expect(renderer.root.findByProps({ role: "listbox", "aria-label": "执行 Agent" })).toBeTruthy();
    act(() => {
      renderer.root.findAllByProps({ role: "option" })[2].props.onClick();
    });
    expect(onTemplatePatch).toHaveBeenCalledWith("agent-1", { provider: "codex" });
  });
});
