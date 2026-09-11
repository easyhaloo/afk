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
