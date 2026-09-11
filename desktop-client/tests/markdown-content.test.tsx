import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { MarkdownContent } from "../src/features/backlog/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders GitHub-flavored Markdown headings, emphasis, and task lists", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(MarkdownContent, {
        source: "## Acceptance Criteria\n\n- [x] **marker** exists",
      }));
    });

    expect(renderer.root.findByType("h2").children.join("")).toBe("Acceptance Criteria");
    expect(renderer.root.findByType("strong").children.join("")).toBe("marker");
    expect(renderer.root.findByType("input").props.type).toBe("checkbox");
    expect(renderer.root.findByType("input").props.checked).toBe(true);
    renderer.unmount();
  });

  it("recognizes Mermaid fenced blocks as diagrams instead of plain code", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(MarkdownContent, {
        source: "```mermaid\nflowchart TD\n  A[准备] --> B[执行]\n```",
      }));
    });

    expect(renderer.root.findByProps({ className: "markdown-mermaid" })).toBeTruthy();
    renderer.unmount();
  });
});
