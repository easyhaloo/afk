import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { SelectMenu } from "../src/components/SelectMenu";

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
});
