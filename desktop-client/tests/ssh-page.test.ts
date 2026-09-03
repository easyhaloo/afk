import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { filterSshHosts, SshHostsPage, sshDiagnosticTypeLabel } from "../src/features/ssh/SshHostsPage";
import type { SshHost } from "../shared/ssh-contract";

const hosts: SshHost[] = [
  { id: "system:prod", alias: "prod", hostname: "10.0.0.1", port: 22, source: "system", configPath: "~/.ssh/config", status: "ready" },
  { id: "managed:stage", alias: "stage", hostname: "staging.example.test", port: 2200, source: "managed", configPath: "~/.ssh/afk_hosts", status: "untrusted" },
];

describe("SSH host filtering", () => {
  it("combines query, source, and status without mutating the list", () => {
    expect(filterSshHosts(hosts, "staging", "managed", "untrusted")).toEqual([hosts[1]]);
    expect(hosts).toHaveLength(2);
  });
});

describe("SSH diagnostic type labels", () => {
  it("returns exact labels for safety, existing, and unknown diagnostic codes", () => {
    expect(sshDiagnosticTypeLabel("ssh.host-key-checking-disabled")).toBe("主机密钥校验已关闭");
    expect(sshDiagnosticTypeLabel("ssh.known-hosts-disabled")).toBe("known_hosts 已禁用");
    expect(sshDiagnosticTypeLabel("ssh.malformed-directive")).toBe("无法解析的配置行");
    expect(sshDiagnosticTypeLabel("ssh.unknown-directive")).toBe("配置诊断");
  });
});

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textContent(child as ReactTestInstance)).join("");
}

function createSshPageHarness() {
  const connect = vi.fn(async () => ({ id: "session-1", hostId: hosts[0].id, alias: hosts[0].alias, state: "open" as const, output: "" }));
  const openExternal = vi.fn(async () => ({ terminal: "iterm2" }));
  const list = vi.fn(async () => ({ hosts, diagnostics: [] }));
  const api = {
    list,
    connect,
    openExternal,
    add: vi.fn(),
    remove: vi.fn(),
    trust: vi.fn(),
    generateKey: vi.fn(),
    deployKey: vi.fn(),
    test: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("window", { afkDesktop: { ssh: api } });
  return { api, connect, openExternal, list };
}

async function renderSshPage(onSession = vi.fn()) {
  const harness = createSshPageHarness();
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(SshHostsPage, { onSession }));
    await Promise.resolve();
  });
  return { ...harness, renderer: renderer!, onSession };
}

describe("SSH connection modes", () => {
  it("shows one terminal selector with built-in and external choices", async () => {
    const { renderer } = await renderSshPage();
    const selector = renderer.root.findByProps({ id: "ssh-terminal-select" });
    const labels = selector.findAllByType("option").map((option) => textContent(option));

    expect(labels).toEqual(["内置终端", "iTerm2", "Warp", "Ghostty", "cmux", "Terminal.app"]);
    expect(selector.props.value).toBe("builtin");
    renderer.unmount();
    vi.unstubAllGlobals();
  });

  it("opens the built-in terminal when the built-in option is selected", async () => {
    const onSession = vi.fn();
    const { renderer, connect, openExternal } = await renderSshPage(onSession);
    const connectButton = () => renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    await act(async () => { connectButton().props.onClick(); await Promise.resolve(); });
    expect(connect).toHaveBeenCalledWith(hosts[0].id);
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
    renderer.unmount();
    vi.unstubAllGlobals();
  });

  it("opens the explicitly selected external terminal without creating an internal session", async () => {
    const onSession = vi.fn();
    const { renderer, connect, openExternal, list } = await renderSshPage(onSession);
    openExternal.mockResolvedValue({ terminal: "ghostty" });
    const selector = renderer.root.findByProps({ id: "ssh-terminal-select" });
    const connectButton = () => renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    await act(async () => { selector.props.onChange({ target: { value: "ghostty" } }); });
    await act(async () => { connectButton().props.onClick(); await Promise.resolve(); });
    expect(openExternal).toHaveBeenCalledWith(hosts[0].id, "ghostty");
    expect(connect).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "status" })).toBeDefined();
    expect(textContent(renderer.root.findByProps({ role: "status" }))).toContain("Ghostty");
    renderer.unmount();
    vi.unstubAllGlobals();
  });

  it("shows an operation-specific busy label while the selected external terminal is starting", async () => {
    let resolveExternal: (() => void) | undefined;
    const { renderer } = await renderSshPage();
    const pageApi = (globalThis.window as unknown as { afkDesktop: { ssh: { openExternal: (hostId: string) => Promise<{ terminal: string }> } } }).afkDesktop;
    pageApi.ssh.openExternal = vi.fn(() => new Promise<{ terminal: string }>((resolve) => { resolveExternal = () => resolve({ terminal: "warp" }); }));
    const selector = renderer.root.findByProps({ id: "ssh-terminal-select" });
    await act(async () => { selector.props.onChange({ target: { value: "warp" } }); });
    const connectButton = () => renderer.root.findAllByType("button").find((button) => button.props.className?.includes("ssh-primary-action") && textContent(button).includes("连接"))!;

    await act(async () => { connectButton().props.onClick(); await Promise.resolve(); });
    expect(textContent(connectButton())).toContain("连接中");
    expect(connectButton().props.disabled).toBe(true);

    await act(async () => { resolveExternal?.(); await Promise.resolve(); });
    expect(textContent(renderer.root.findByProps({ role: "status" }))).toContain("Warp");
    renderer.unmount();
    vi.unstubAllGlobals();
  });

  it("shows external launch errors without creating an internal session", async () => {
    const onSession = vi.fn();
    const { renderer, openExternal } = await renderSshPage(onSession);
    openExternal.mockRejectedValue(new Error("外部终端启动失败"));
    const selector = renderer.root.findByProps({ id: "ssh-terminal-select" });
    await act(async () => { selector.props.onChange({ target: { value: "cmux" } }); });
    const connectButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    await act(async () => { connectButton.props.onClick(); await Promise.resolve(); });
    expect(textContent(renderer.root.findByProps({ role: "alert" }))).toContain("外部终端启动失败");
    expect(onSession).not.toHaveBeenCalled();
    renderer.unmount();
    vi.unstubAllGlobals();
  });

  it("keeps the external action behind the existing Host trust gate", async () => {
    const { renderer, openExternal } = await renderSshPage();
    const untrustedHost = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row") && textContent(node).includes("stage"));
    await act(async () => { untrustedHost[0].props.onClick(); });
    const selector = renderer.root.findByProps({ id: "ssh-terminal-select" });
    const connectButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    expect(selector.props.disabled).toBe(true);
    expect(connectButton.props.disabled).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    renderer.unmount();
    vi.unstubAllGlobals();
  });
});
