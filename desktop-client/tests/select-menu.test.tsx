import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { SelectMenu } from "../src/components/SelectMenu";

describe("SelectMenu", () => {
  it("supports centering the selected label while keeping the trigger affordance visible", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(SelectMenu, {
        label: "选择 Provider",
        value: "auto",
        options: [{ value: "auto", label: "自动探测" }, { value: "github", label: "GitHub" }],
        onChange: vi.fn(),
        align: "center",
      }));
    });

    expect(renderer.root.findByProps({ className: "select-menu-trigger centered" })).toBeTruthy();

    act(() => { renderer.root.findByProps({ className: "select-menu-trigger centered" }).props.onClick(); });
    expect(renderer.root.findAll((node) => {
      const className = node.props.className;
      return typeof className === "string" && className.split(" ").includes("select-menu-option") && className.split(" ").includes("centered");
    })).toHaveLength(2);
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
