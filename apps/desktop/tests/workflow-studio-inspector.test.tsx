import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkflowStudioInspector } from "../src/main.js";
import { DEMO_SNAPSHOT } from "../src/mock-data.js";
import { SelectMenu } from "../src/components/SelectMenu.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  workflow: DEMO_SNAPSHOT.workflow,
  loop: DEMO_SNAPSHOT.loop,
  runs: [],
  onPatch: vi.fn(), onCodexPatch: vi.fn(), onTemplatePatch: vi.fn(), onDeleteTemplate: vi.fn(),
  dirty: true, saving: false, error: null, onSave: vi.fn(async () => undefined), onReset: vi.fn(), onCollapse: vi.fn(),
};

describe("workflow studio inspector", () => {
  it("offers registered plugin providers for node editing without accepting arbitrary names", () => {
    let renderer!: ReturnType<typeof create>;
    const onTemplatePatch = vi.fn();
    const custom = { id: "implement", template: "agent" as const, label: "实现", description: "实现", prompt: "Implement", provider: "enterprise-agent", x: 0, y: 0 };
    act(() => {
      renderer = create(<WorkflowStudioInspector {...props} agentProviders={["claude-code", "codex", "enterprise-agent"]} onTemplatePatch={onTemplatePatch} node={{
        id: "custom-implement", number: "01", title: "实现", caption: "enterprise-agent", state: "ready", x: 0, y: 0, custom,
      }} />);
    });
    const selector = renderer.root.findByType(SelectMenu);
    expect(selector.props.options.map((option: { value: string }) => option.value)).toEqual(["", "claude-code", "codex", "enterprise-agent"]);
    act(() => selector.props.onChange("enterprise-agent"));
    expect(onTemplatePatch).toHaveBeenCalledWith("implement", { provider: "enterprise-agent" });
    expect(selector.props.options.some((option: { value: string }) => option.value === "unregistered-agent")).toBe(false);
  });

  it("uses the registry provider list for the workflow default selector", () => {
    let renderer!: ReturnType<typeof create>;
    const onPatch = vi.fn();
    act(() => {
      renderer = create(<WorkflowStudioInspector {...props} agentProviders={["claude-code", "codex", "enterprise-agent", "another-agent"]} onPatch={onPatch} node={{ id: "start", number: "00", title: "开始", caption: "Issue", state: "ready", x: 0, y: 0 }} />);
    });
    const selector = renderer.root.findAllByType(SelectMenu).find((candidate: { props: { label?: string } }) => candidate.props.label === "默认 Agent")!;
    expect(selector.props.options.map((option: { value: string }) => option.value)).toContain("enterprise-agent");
    act(() => selector.props.onChange("enterprise-agent"));
    expect(onPatch).toHaveBeenCalledWith({ agentDefault: "enterprise-agent" });
  });

  it("groups multiple dependencies and their execution rule without repeating the current step", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<WorkflowStudioInspector {...props} node={{
        id: "step-publish", number: "04", title: "publish", caption: "publish-changes", state: "ready", x: 0, y: 0,
        step: { id: "publish", kind: "system", role: "system", action: "publish-changes", dependsOn: ["verify-ac", "review"] },
      }} />);
    });
    const dependencies = renderer.root.findByProps({ "aria-label": "前置依赖" });
    expect(dependencies.findAllByProps({ className: "workflow-dependency-chip" }).map(chip => chip.children.join(""))).toEqual(["verify-ac", "review"]);
    expect(dependencies.findByType("p").children).toEqual(["全部依赖完成后执行。"]);
    expect(dependencies.findAllByType("svg")).toHaveLength(0);
    expect(dependencies.findAllByType("b")).toHaveLength(0);
  });

  it("groups startup settings and converts minutes to the existing millisecond contract", () => {
    let renderer!: ReturnType<typeof create>;
    const onPatch = vi.fn();
    act(() => {
      renderer = create(<WorkflowStudioInspector {...props} onPatch={onPatch} node={{ id: "start", number: "00", title: "开始", caption: "Issue 实现", state: "ready", x: 0, y: 0 }} />);
    });
    expect(renderer.root.findByProps({ "aria-label": "执行环境" })).toBeTruthy();
    expect(renderer.root.findByProps({ "aria-label": "重试与超时" })).toBeTruthy();
    const timeout = renderer.root.findAllByType("label").find(label => label.findAllByType("span").some(span => span.children.includes("工作流超时（分钟）")))!;
    act(() => timeout.findByType("input").props.onChange({ target: { value: "2.5" } }));
    expect(onPatch).toHaveBeenCalledWith({ hardTimeoutMs: 150000 });
    expect(renderer.root.findAllByType("button").filter(button => button.children.includes("保存"))).toHaveLength(0);
  });
});
