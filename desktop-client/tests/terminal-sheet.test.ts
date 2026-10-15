import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { SshSession } from "../shared/ssh-contract";
import { TerminalSheet } from "../src/features/terminal/TerminalSheet";
import { SshTerminalView } from "../src/features/terminal/SshTerminalView";

const session: SshSession = {
  id: "ssh-1",
  hostId: "host-1",
  alias: "stage",
  kind: "ssh",
  title: "stage terminal",
  state: "open",
};

function renderTerminalSheet() {
  return create(createElement(TerminalSheet, {
    mode: "ssh",
    session: "",
    pane: "connected",
    line: "",
    confirmed: false,
    sshSession: session,
    onClose: vi.fn(),
    onLine: vi.fn(),
    onConfirmed: vi.fn(),
    onSend: vi.fn(),
  }), { createNodeMock: () => ({ contains: () => true }) });
}

describe("TerminalSheet", () => {
  it("shows an unavailable attachment as a read-only notice without legacy send controls", () => {
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(TerminalSheet, {
      mode: "notice", session: "previous-session", pane: "该运行没有已登记的执行环境资源", line: "old command", confirmed: true,
      onClose: vi.fn(), onLine: vi.fn(), onConfirmed: vi.fn(), onSend: vi.fn(),
    })); });
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(renderer.root.findByType("pre").children).toContain("该运行没有已登记的执行环境资源");
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });
  it("keeps Escape available to the attached agent and closes through the explicit button", () => {
    const listeners = new Map<string, (event: { key: string }) => void>();
    vi.stubGlobal("document", {
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
    });
    const onClose = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(TerminalSheet, {
      mode: "attach", session: "attach-1", pane: "", line: "", confirmed: false,
      onClose, onLine: vi.fn(), onConfirmed: vi.fn(), onSend: vi.fn(),
    })); });
    act(() => listeners.get("keydown")?.({ key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => renderer!.root.findByProps({ "aria-label": "关闭终端" }).props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
    act(() => renderer!.unmount());
    vi.unstubAllGlobals();
  });

  it("switches the built-in SSH terminal into a standalone interface", () => {
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    let renderer: ReturnType<typeof create>;
    act(() => { renderer = renderTerminalSheet(); });

    expect(renderer!.root.findByType("section").props.className).not.toContain("standalone");
    act(() => renderer!.root.findByProps({ "aria-label": "独立显示终端" }).props.onClick());
    expect(renderer!.root.findByType("section").props.className).toContain("standalone");
    expect(renderer!.root.findByProps({ "aria-label": "恢复浮动终端" })).toBeTruthy();

    act(() => renderer!.unmount());
    vi.unstubAllGlobals();
  });

  it("changes the SSH terminal font size within safe bounds", () => {
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    let renderer: ReturnType<typeof create>;
    act(() => { renderer = renderTerminalSheet(); });

    expect(renderer!.root.findByType(SshTerminalView).props.fontSize).toBe(11);
    act(() => renderer!.root.findByProps({ "aria-label": "放大终端文字" }).props.onClick());
    expect(renderer!.root.findByType(SshTerminalView).props.fontSize).toBe(12);

    for (let index = 0; index < 20; index += 1) {
      act(() => renderer!.root.findByProps({ "aria-label": "缩小终端文字" }).props.onClick());
    }
    expect(renderer!.root.findByType(SshTerminalView).props.fontSize).toBe(9);
    expect(renderer!.root.findByProps({ "aria-label": "缩小终端文字" }).props.disabled).toBe(true);

    act(() => renderer!.unmount());
    vi.unstubAllGlobals();
  });
});
