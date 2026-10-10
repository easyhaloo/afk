import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../src/components/SegmentedControl";
import { FilterPanel } from "../src/components/FilterPanel";
import { SelectMenu } from "../src/components/SelectMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("selection controls", () => {
  it("exposes an immediate single selection and wraps with arrow keys", () => {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(SegmentedControl, { label: "执行模式", value: "afk", options: [{ value: "afk", label: "自动" }, { value: "hitl", label: "人工" }], onChange })); });
    const buttons = renderer.root.findAllByProps({ role: "radio" });
    expect(buttons.map(button => button.props["aria-checked"])).toEqual([true, false]);
    expect(buttons.map(button => button.props.tabIndex)).toEqual([0, -1]);
    act(() => { buttons[0].props.onKeyDown({ key: "ArrowLeft", preventDefault: vi.fn() }); });
    expect(onChange).toHaveBeenCalledWith("hitl");
    act(() => renderer.unmount());
  });

  it("disables all segments without calling onChange", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(SegmentedControl, { label: "模式", value: "one", options: [{ value: "one", label: "一" }], onChange: vi.fn(), disabled: true })); });
    expect(renderer.root.findByProps({ role: "radio" }).props.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it("discloses filters and removes individual conditions", () => {
    const onClear = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(FilterPanel, { label: "筛选工作项", filters: [{ key: "state", label: "状态：验证中", onClear }], children: createElement("input", { "aria-label": "筛选内容" }) })); });
    const trigger = renderer.root.findByProps({ "aria-label": "筛选工作项" });
    expect(trigger.props["aria-expanded"]).toBe(false);
    act(() => trigger.props.onClick());
    expect(renderer.root.findByProps({ "aria-label": "筛选条件" }).props.hidden).toBe(false);
    act(() => renderer.root.findByProps({ "aria-label": "移除筛选：状态：验证中" }).props.onClick());
    expect(onClear).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it("searches resource descriptions and selects with the keyboard", () => {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(SelectMenu, { label: "选择资源", value: "first", options: [{ value: "first", label: "API", description: "acme/service" }, { value: "second", label: "Web", description: "acme/frontend" }], onChange, search: { label: "搜索资源" } })); });
    act(() => renderer.root.findByProps({ "aria-label": "选择资源" }).props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "搜索资源" }).props.onChange({ target: { value: "frontend" } }));
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(1);
    act(() => renderer.root.findByProps({ className: "select-menu" }).props.onKeyDown({ key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    expect(onChange).toHaveBeenCalledWith("second");
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("does not relabel an unavailable current resource as the first option", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(SelectMenu, { label: "模板", value: "missing", options: [{ value: "other", label: "其他模板" }], onChange: vi.fn() })); });
    expect(renderer.root.findByProps({ className: "select-menu-trigger-value" }).children).toEqual(["missing"]);
    act(() => renderer.unmount());
  });

  it("remembers recent resources locally and closes when the control becomes disabled", () => {
    const props = { label: "资源", value: "one", options: [{ value: "one", label: "一" }, { value: "two", label: "二" }], onChange: vi.fn(), search: { label: "搜索" } };
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(SelectMenu, props)); });
    act(() => renderer.root.findByProps({ "aria-label": "资源" }).props.onClick());
    act(() => renderer.root.findAllByProps({ role: "option" })[1].props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "资源" }).props.onClick());
    expect(renderer.root.findAllByProps({ role: "option" })[0].props.title).toBe("二");
    act(() => renderer.update(createElement(SelectMenu, { ...props, disabled: true })));
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
