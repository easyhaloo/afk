import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkflowStudioInspector } from "../src/main";
import { DEMO_SNAPSHOT } from "../src/mock-data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  workflow: DEMO_SNAPSHOT.workflow,
  loop: DEMO_SNAPSHOT.loop,
  runs: [],
  onPatch: vi.fn(), onCodexPatch: vi.fn(), onTemplatePatch: vi.fn(), onDeleteTemplate: vi.fn(),
  dirty: true, saving: false, error: null, onSave: vi.fn(async () => undefined), onReset: vi.fn(), onCollapse: vi.fn(),
};

describe("workflow studio inspector", () => {
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
