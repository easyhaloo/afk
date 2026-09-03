import { describe, expect, it } from "vitest";
import {
  terminalOutputUpdate,
  xtermKeyAction,
  type TerminalPlatform,
} from "../src/features/terminal/ssh-terminal-model";

type KeyInput = {
  platform: TerminalPlatform;
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  hasSelection?: boolean;
};

function keyAction(input: KeyInput) {
  return xtermKeyAction({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    hasSelection: false,
    ...input,
  });
}

describe("terminal output updates", () => {
  it("does nothing when both outputs are empty", () => {
    expect(terminalOutputUpdate("", "")).toEqual({ reset: false, data: "" });
  });

  it("writes the full first output without resetting", () => {
    expect(terminalOutputUpdate("", "first output")).toEqual({ reset: false, data: "first output" });
  });

  it("writes only appended PTY output", () => {
    expect(terminalOutputUpdate("hello", "hello world")).toEqual({ reset: false, data: " world" });
  });

  it("does nothing when output is unchanged", () => {
    expect(terminalOutputUpdate("same", "same")).toEqual({ reset: false, data: "" });
  });

  it("resets when the session output is replaced", () => {
    expect(terminalOutputUpdate("old", "new")).toEqual({ reset: true, data: "new" });
  });

  it("resets when a non-empty output is cleared", () => {
    expect(terminalOutputUpdate("previous output", "")).toEqual({ reset: true, data: "" });
  });

  it("resets when cumulative output becomes shorter", () => {
    expect(terminalOutputUpdate("first output", "first")).toEqual({ reset: true, data: "first" });
  });
});

describe("xterm keyboard actions", () => {
  it("copies a selected terminal range with Meta+C on macOS", () => {
    expect(keyAction({ platform: "mac", key: "c", metaKey: true, hasSelection: true })).toBe("copy");
  });

  it("keeps Ctrl+C under terminal control on macOS", () => {
    expect(keyAction({ platform: "mac", key: "c", ctrlKey: true, hasSelection: true })).toBe("terminal");
  });

  it.each([
    ["Ctrl+C", { platform: "other" as const, key: "c", ctrlKey: true, hasSelection: true }],
    ["Ctrl+Shift+C", { platform: "other" as const, key: "c", ctrlKey: true, shiftKey: true, hasSelection: true }],
  ])("copies a selected terminal range with %s on other platforms", (_label, input) => {
    expect(keyAction(input)).toBe("copy");
  });

  it("keeps Ctrl+C under terminal control without a selection", () => {
    expect(keyAction({ platform: "other", key: "c", ctrlKey: true })).toBe("terminal");
  });

  it.each([
    ["Meta+V on macOS", { platform: "mac" as const, key: "v", metaKey: true }],
    ["Ctrl+Shift+V on other platforms", { platform: "other" as const, key: "v", ctrlKey: true, shiftKey: true }],
  ])("uses native paste for %s", (_label, input) => {
    expect(keyAction(input)).toBe("native-paste");
  });

  it.each([
    ["plain input", { platform: "other" as const, key: "a" }],
    ["Meta+C without a selection", { platform: "mac" as const, key: "c", metaKey: true }],
  ])("leaves %s under terminal control", (_label, input) => {
    expect(keyAction(input)).toBe("terminal");
  });

  it("ignores Ctrl+Shift+C without a selection on other platforms", () => {
    expect(keyAction({ platform: "other", key: "c", ctrlKey: true, shiftKey: true })).toBe("ignore");
  });
});
