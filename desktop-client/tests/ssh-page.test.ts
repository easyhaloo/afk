import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { filterSshHosts, SshHostsPage, sshDiagnosticTypeLabel } from "../src/features/ssh/SshHostsPage";
import { resetSshHostCache, writeSshHostCache } from "../src/features/ssh/ssh-host-cache";
import type { SshHost, SshListResult } from "../shared/ssh-contract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { document?: unknown }).document = { addEventListener: vi.fn(), removeEventListener: vi.fn(), activeElement: null };

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

beforeEach(() => {
  resetSshHostCache();
});

describe("SSH diagnostic type labels", () => {
  it("returns exact labels for safety, existing, and unknown diagnostic codes", () => {
    expect(sshDiagnosticTypeLabel("ssh.host-key-checking-disabled")).toBe("主机密钥校验已关闭");
    expect(sshDiagnosticTypeLabel("ssh.known-hosts-disabled")).toBe("known_hosts 已禁用");
    expect(sshDiagnosticTypeLabel("ssh.malformed-directive")).toBe("无法解析的配置行");
    expect(sshDiagnosticTypeLabel("ssh.unknown-directive")).toBe("配置诊断");
  });
});

describe("SSH diagnostic panel", () => {
  it("starts collapsed and expands when its header is clicked", async () => {
    const { renderer } = await renderSshPage(vi.fn(), async () => ({
      hosts,
      diagnostics: [{ code: "ssh.host-key-checking-disabled", severity: "warning", message: "主机密钥校验已关闭", path: "~/.ssh/config", hostAlias: "prod" }],
    }));
    const toggle = renderer.root.findByProps({ className: "ssh-diagnostics-toggle" });

    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(renderer.root.findAllByProps({ className: "ssh-diagnostic-list" })).toHaveLength(0);

    await act(async () => {
      toggle.props.onClick();
      await flushReactUpdates();
    });

    expect(toggle.props["aria-expanded"]).toBe(true);
    expect(renderer.root.findByProps({ className: "ssh-diagnostic-list" })).toBeDefined();
    act(() => { renderer.unmount(); });
  });
});

describe("SSH host editing", () => {
  it("opens the edit modal with managed host values on double click", async () => {
    const { renderer } = await renderSshPage();
    const managedRow = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[1];

    await act(async () => {
      managedRow.props.onDoubleClick();
      await flushReactUpdates();
    });

    expect(renderer.root.findByProps({ role: "dialog" })).toBeDefined();
    expect(renderer.root.findAllByProps({ value: "stage" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ value: "staging.example.test" })).toHaveLength(1);
    expect(renderer.root.findByProps({ children: "编辑 SSH 主机" })).toBeDefined();
    act(() => { renderer.unmount(); });
  });

  it("does not open the edit modal for a system host", async () => {
    const { renderer } = await renderSshPage();
    const systemRow = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0];

    await act(async () => {
      systemRow.props.onDoubleClick();
      await flushReactUpdates();
    });

    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it("submits edits through update and refreshes the host list", async () => {
    const { renderer, api, list } = await renderSshPage();
    const managedRow = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[1];

    await act(async () => {
      managedRow.props.onDoubleClick();
      await flushReactUpdates();
    });
    const hostname = renderer.root.findAllByProps({ value: "staging.example.test" })[0];
    await act(async () => { hostname.props.onChange({ target: { value: "stage-new.example.test" } }); await flushReactUpdates(); });
    await act(async () => {
      const form = renderer.root.findByProps({ role: "dialog" });
      form.props.onSubmit({ preventDefault: vi.fn() });
      await flushReactUpdates();
    });

    expect(api.update).toHaveBeenCalledWith("managed:stage", expect.objectContaining({ hostname: "stage-new.example.test" }));
    expect(list).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    act(() => { renderer.unmount(); });
  });
});

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textContent(child as ReactTestInstance)).join("");
}

async function flushReactUpdates() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSshPageHarness(listImplementation: () => Promise<SshListResult> = async () => ({ hosts, diagnostics: [] })) {
  const savedCredentials = new Set<string>();
  const connect = vi.fn(async () => ({ id: "session-1", hostId: hosts[0].id, alias: hosts[0].alias, state: "open" as const, output: "" }));
  const openExternal = vi.fn(async () => ({ terminal: "iterm2" }));
  const list = vi.fn(listImplementation);
  const credentials = {
    has: vi.fn(async (hostId: string) => savedCredentials.has(hostId)),
    set: vi.fn(async ({ hostId }: { hostId: string; password: string }) => { savedCredentials.add(hostId); return true; }),
    remove: vi.fn(async (hostId: string) => { savedCredentials.delete(hostId); return true; }),
  };
  const api = {
    list,
    connect,
    openExternal,
    add: vi.fn(),
    update: vi.fn(async (_hostId: string, input: Partial<SshHost>) => ({ ...hosts[1], ...input, id: `managed:${input.alias}` })),
    remove: vi.fn(),
    trust: vi.fn(),
    generateKey: vi.fn(),
    deployKey: vi.fn(),
    test: vi.fn(),
    upload: vi.fn(async () => ({ fileName: "release.txt", remoteDirectory: "~/" })),
    input: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
    credentialHas: credentials.has,
    credentialSet: credentials.set,
    credentialRemove: credentials.remove,
  };
  vi.stubGlobal("window", { afkDesktop: { ssh: api } });
  return { api, connect, openExternal, list, credentials };
}

async function renderSshPage(onSession = vi.fn(), listImplementation?: () => Promise<SshListResult>) {
  const harness = createSshPageHarness(listImplementation);
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(SshHostsPage, { onSession }));
    await flushReactUpdates();
  });
  return { ...harness, renderer: renderer!, onSession };
}

describe("SSH passwordless test loading", () => {
  it("keeps loading feedback on the test action instead of spinning the refresh button", async () => {
    const testRequest = deferred<void>();
    const refreshRequest = deferred<SshListResult>();
    const { renderer, api, list } = await renderSshPage();
    api.test.mockImplementation(() => testRequest.promise);
    list.mockImplementationOnce(() => refreshRequest.promise);

    const testButton = () => renderer.root.findByProps({ className: "ssh-test-action" });
    const refreshButton = () => renderer.root.findByProps({ "aria-label": "刷新 SSH 主机" });

    await act(async () => {
      testButton().props.onClick();
      await flushReactUpdates();
    });
    expect(textContent(testButton())).toContain("测试中");
    expect(testButton().findByProps({ className: "spin" })).toBeDefined();
    expect(refreshButton().findAllByProps({ className: "spin" })).toHaveLength(0);

    await act(async () => {
      testRequest.resolve();
      await flushReactUpdates();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(textContent(testButton())).toContain("测试中");
    expect(refreshButton().findAllByProps({ className: "spin" })).toHaveLength(0);

    await act(async () => {
      refreshRequest.resolve({ hosts, diagnostics: [] });
      await flushReactUpdates();
    });
    expect(textContent(testButton())).toBe("测试免密");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });
});

describe("SSH SCP uploads", () => {
  it("uploads a file for the selected ready host and reports the result", async () => {
    const { renderer, api } = await renderSshPage();
    const uploadButton = renderer.root.findByProps({ className: "ssh-upload-action" });

    await act(async () => {
      uploadButton.props.onClick();
      await flushReactUpdates();
    });

    expect(api.upload).toHaveBeenCalledWith(hosts[0].id);
    expect(textContent(renderer.root.findByProps({ role: "status" }))).toContain("已上传 release.txt");
    act(() => { renderer.unmount(); });
  });

  it("disables file uploads for hosts that are not ready", async () => {
    const { renderer } = await renderSshPage(vi.fn(), async () => ({ hosts, diagnostics: [] }));
    const untrustedRow = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[1];

    await act(async () => {
      untrustedRow.props.onClick();
      await flushReactUpdates();
    });

    expect(renderer.root.findByProps({ className: "ssh-upload-action" }).props.disabled).toBe(true);
    act(() => { renderer.unmount(); });
  });
});

describe("SSH connection modes", () => {
  it("offers cleanup for unreachable system hosts without exposing deletion for reachable system hosts", async () => {
    const unreachable = { ...hosts[0], id: "system:dead", alias: "dead", status: "unreachable" as const };
    const { renderer, api, list } = await renderSshPage(vi.fn(), async () => ({ hosts: [hosts[0], unreachable], diagnostics: [] }));

    expect(renderer.root.findAllByProps({ "aria-label": "删除 SSH 主机 prod" })).toHaveLength(0);
    const cleanupButton = renderer.root.findByProps({ "aria-label": "清理不可达 SSH 主机 dead" });
    await act(async () => { cleanupButton.props.onClick({ stopPropagation: vi.fn() }); await flushReactUpdates(); });

    expect(renderer.root.findByProps({ role: "dialog", "aria-label": "清理不可达 SSH 主机 dead" })).toBeDefined();
    expect(api.remove).not.toHaveBeenCalled();
    const confirmButton = renderer.root.findByProps({ "aria-label": "确认清理不可达 SSH 主机 dead" });
    await act(async () => { confirmButton.props.onClick(); await flushReactUpdates(); });

    expect(api.remove).toHaveBeenCalledWith(unreachable.id);
    expect(list).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("uses compact action buttons across the SSH host page", async () => {
    const { renderer } = await renderSshPage();
    const actionButtons = renderer.root.findAllByType("button").filter((button) => button.props.className?.includes("ssh-action-button"));

    expect(actionButtons.length).toBeGreaterThan(0);
    expect(actionButtons.every((button) => button.props.className.includes("ssh-action-button-sm"))).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it("gives the SSH detail actions a clear primary hierarchy", async () => {
    const managedReadyHost = { ...hosts[0], id: "managed:prod", source: "managed" as const };
    const { renderer } = await renderSshPage(vi.fn(), async () => ({ hosts: [managedReadyHost], diagnostics: [] }));
    const buttonByText = (label: string) => renderer.root.findAllByType("button").find((button) => textContent(button) === label)!;

    expect(buttonByText("连接").props.className).toContain("ssh-action-button-primary");
    expect(buttonByText("测试免密").props.className).toContain("ssh-action-button-secondary");
    expect(renderer.root.findByProps({ "aria-label": "删除 SSH 主机 prod" }).props.className).toContain("ssh-host-delete");
    expect(renderer.root.findByProps({ "aria-label": "prod SSH 详情" }).findAllByProps({ "aria-label": "删除 SSH 主机 prod" })).toHaveLength(0);
    expect(renderer.root.findByProps({ className: "ssh-detail-action-groups" })).toBeDefined();
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("does not render the deployment password panel in host details", async () => {
    const { renderer } = await renderSshPage();

    expect(renderer.root.findAllByProps({ "aria-label": "部署密码" })).toHaveLength(0);
    expect(renderer.root.findAllByType("input").some((input) => input.props.placeholder === "输入后保存到系统安全存储")).toBe(false);
    expect(renderer.root.findAllByType("button").some((button) => textContent(button).includes("保存部署密码"))).toBe(false);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("shows one terminal selector with built-in and external choices", async () => {
    const { renderer } = await renderSshPage();
    expect(renderer.root.findAllByType("select")).toHaveLength(0);
    const selector = renderer.root.findByProps({ "aria-label": "选择 SSH 终端" });
    await act(async () => { selector.props.onClick(); });
    const listbox = renderer.root.findByProps({ role: "listbox" });
    const options = listbox.findAllByProps({ role: "option" });
    const labels = options.map((option) => textContent(option.findByType("b")));

    expect(labels).toEqual(["内置终端", "iTerm2", "Warp", "Ghostty", "cmux", "Terminal.app"]);
    expect(listbox.props["data-placement"]).toBe("start");
    expect(options.every((option) => option.findAll((node) => node.props["data-terminal-icon"] === option.props["data-terminal-id"]).length === 1)).toBe(true);
    expect(selector.props["aria-expanded"]).toBe(true);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("opens the built-in terminal when the built-in option is selected", async () => {
    const onSession = vi.fn();
    const { renderer, connect, openExternal } = await renderSshPage(onSession);
    const connectButton = () => renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    await act(async () => { connectButton().props.onClick(); await flushReactUpdates(); });
    expect(connect).toHaveBeenCalledWith(hosts[0].id);
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("supports keyboard navigation in the terminal picker", async () => {
    const { renderer } = await renderSshPage();
    const selector = renderer.root.findByProps({ "aria-label": "选择 SSH 终端" });
    const keyEvent = (key: string) => ({ key, preventDefault: vi.fn() });

    await act(async () => { selector.props.onKeyDown(keyEvent("ArrowDown")); });
    await act(async () => { selector.props.onKeyDown(keyEvent("Enter")); });

    expect(textContent(renderer.root.findByProps({ "aria-label": "选择 SSH 终端" }))).toContain("iTerm2");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("opens the explicitly selected external terminal without creating an internal session", async () => {
    const onSession = vi.fn();
    const { renderer, connect, openExternal, list } = await renderSshPage(onSession);
    openExternal.mockResolvedValue({ terminal: "ghostty" });
    const selector = renderer.root.findByProps({ "aria-label": "选择 SSH 终端" });
    const connectButton = () => renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    await act(async () => { selector.props.onClick(); });
    await act(async () => { renderer.root.findByProps({ "data-terminal-id": "ghostty" }).props.onClick(); });
    await act(async () => { connectButton().props.onClick(); await flushReactUpdates(); });
    expect(openExternal).toHaveBeenCalledWith(hosts[0].id, "ghostty");
    expect(connect).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ role: "status" })).toBeDefined();
    expect(textContent(renderer.root.findByProps({ role: "status" }))).toContain("Ghostty");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("shows an operation-specific busy label while the selected external terminal is starting", async () => {
    let resolveExternal: (() => void) | undefined;
    const { renderer } = await renderSshPage();
    const pageApi = (globalThis.window as unknown as { afkDesktop: { ssh: { openExternal: (hostId: string) => Promise<{ terminal: string }> } } }).afkDesktop;
    pageApi.ssh.openExternal = vi.fn(() => new Promise<{ terminal: string }>((resolve) => { resolveExternal = () => resolve({ terminal: "warp" }); }));
    const selector = renderer.root.findByProps({ "aria-label": "选择 SSH 终端" });
    await act(async () => { selector.props.onClick(); });
    await act(async () => { renderer.root.findByProps({ "data-terminal-id": "warp" }).props.onClick(); });
    const connectButton = () => renderer.root.findAllByType("button").find((button) => button.props.className?.includes("ssh-connect-action") && textContent(button).includes("连接"))!;

    await act(async () => { connectButton().props.onClick(); await flushReactUpdates(); });
    expect(textContent(connectButton())).toContain("连接中");
    expect(connectButton().props.disabled).toBe(true);

    await act(async () => { resolveExternal?.(); await flushReactUpdates(); });
    expect(textContent(renderer.root.findByProps({ role: "status" }))).toContain("Warp");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("shows external launch errors without creating an internal session", async () => {
    const onSession = vi.fn();
    const { renderer, openExternal } = await renderSshPage(onSession);
    openExternal.mockRejectedValue(new Error("外部终端启动失败"));
    const selector = renderer.root.findByProps({ "aria-label": "选择 SSH 终端" });
    await act(async () => { selector.props.onClick(); });
    await act(async () => { renderer.root.findByProps({ "data-terminal-id": "cmux" }).props.onClick(); });
    const connectButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    await act(async () => { connectButton.props.onClick(); await flushReactUpdates(); });
    expect(textContent(renderer.root.findByProps({ role: "alert" }))).toContain("外部终端启动失败");
    expect(onSession).not.toHaveBeenCalled();
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("keeps the external action behind the existing Host trust gate", async () => {
    const { renderer, openExternal } = await renderSshPage();
    const untrustedHost = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row") && textContent(node).includes("stage"));
    await act(async () => { untrustedHost[0].props.onClick(); });
    const selector = renderer.root.findByProps({ "aria-label": "选择 SSH 终端" });
    const connectButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "连接")!;

    expect(selector.props.disabled).toBe(true);
    expect(connectButton.props.disabled).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("shows a cached host list immediately on a later mount without listing again", async () => {
    const first = await renderSshPage();
    act(() => { first.renderer.unmount(); });
    vi.unstubAllGlobals();

    const second = await renderSshPage();
    expect(second.list).not.toHaveBeenCalled();
    expect(textContent(second.renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0])).toContain("prod");
    act(() => { second.renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("forces a fresh list when the refresh button is clicked", async () => {
    const { renderer, list } = await renderSshPage();
    const refreshButton = renderer.root.findByProps({ "aria-label": "刷新 SSH 主机" });

    await act(async () => { refreshButton.props.onClick(); await flushReactUpdates(); });
    expect(list).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("shows expired cached hosts while refreshing them in the background", async () => {
    writeSshHostCache({ hosts, diagnostics: [] }, Date.now() - 31_000);
    const refreshedHost = { ...hosts[0], alias: "refreshed" };
    const { renderer, list } = await renderSshPage(vi.fn(), async () => ({ hosts: [refreshedHost, hosts[1]], diagnostics: [] }));

    expect(list).toHaveBeenCalledTimes(1);
    expect(textContent(renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0])).toContain("refreshed");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("keeps the cached hosts visible when a background refresh fails", async () => {
    writeSshHostCache({ hosts, diagnostics: [] }, Date.now() - 31_000);
    const { renderer } = await renderSshPage(vi.fn(), async () => { throw new Error("刷新失败"); });

    expect(textContent(renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0])).toContain("prod");
    expect(textContent(renderer.root.findByProps({ role: "alert" }))).toContain("刷新失败");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("keeps forced-refresh data when an older normal request finishes later", async () => {
    const normalResult: SshListResult = { hosts: [{ ...hosts[0], alias: "normal" }], diagnostics: [] };
    const forcedResult: SshListResult = { hosts: [{ ...hosts[0], alias: "forced" }], diagnostics: [] };
    const normal = deferred<SshListResult>();
    const forced = deferred<SshListResult>();
    const { list } = createSshPageHarness();
    list
      .mockImplementationOnce(() => normal.promise)
      .mockImplementationOnce(() => forced.promise);
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(createElement(SshHostsPage, { onSession: vi.fn() }));
      await flushReactUpdates();
    });

    const refreshButton = renderer!.root.findByProps({ "aria-label": "刷新 SSH 主机" });
    await act(async () => {
      refreshButton.props.onClick();
      await flushReactUpdates();
    });
    expect(list).toHaveBeenNthCalledWith(2, { forceRefresh: true });

    await act(async () => {
      normal.resolve(normalResult);
      await normal.promise;
      await flushReactUpdates();
    });
    expect(refreshButton.props.disabled).toBe(true);

    await act(async () => {
      forced.resolve(forcedResult);
      await forced.promise;
      await flushReactUpdates();
    });
    expect(textContent(renderer!.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0])).toContain("forced");
    expect(textContent(renderer!.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0])).not.toContain("normal");
    expect(refreshButton.props.disabled).toBe(false);
    act(() => { renderer!.unmount(); });
    vi.unstubAllGlobals();
  });

  it("ignores a stale list failure after a forced refresh succeeds", async () => {
    const forcedResult: SshListResult = { hosts: [{ ...hosts[0], alias: "forced" }], diagnostics: [] };
    const normal = deferred<SshListResult>();
    const forced = deferred<SshListResult>();
    const { list } = createSshPageHarness();
    list
      .mockImplementationOnce(() => normal.promise)
      .mockImplementationOnce(() => forced.promise);
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(createElement(SshHostsPage, { onSession: vi.fn() }));
      await flushReactUpdates();
    });
    const refreshButton = renderer!.root.findByProps({ "aria-label": "刷新 SSH 主机" });
    await act(async () => {
      refreshButton.props.onClick();
      forced.resolve(forcedResult);
      await forced.promise;
      await flushReactUpdates();
    });
    expect(textContent(renderer!.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0])).toContain("forced");

    await act(async () => {
      normal.reject(new Error("旧请求失败"));
      await flushReactUpdates();
    });
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(textContent(renderer!.root.findAll((node) => node.props.className?.includes("ssh-host-row"))[0])).toContain("forced");
    act(() => { renderer!.unmount(); });
    vi.unstubAllGlobals();
  });

  it("does not update state when the pending list request finishes after unmount", async () => {
    const pending = deferred<SshListResult>();
    const { list } = createSshPageHarness(() => pending.promise);
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(createElement(SshHostsPage, { onSession: vi.fn() }));
      await flushReactUpdates();
    });
    expect(list).toHaveBeenCalledTimes(1);

    act(() => { renderer!.unmount(); });
    await act(async () => {
      pending.resolve({ hosts: [{ ...hosts[0], alias: "after-unmount" }], diagnostics: [] });
      await pending.promise;
      await flushReactUpdates();
    });
    expect(renderer!.toJSON()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("invalidates and force-refreshes after removing a managed host", async () => {
    const { renderer, list, api } = await renderSshPage();
    const removeButton = renderer.root.findByProps({ "aria-label": "删除 SSH 主机 stage" });

    await act(async () => { removeButton.props.onClick(); await flushReactUpdates(); });
    expect(renderer.root.findByProps({ role: "dialog", "aria-label": "删除 SSH 主机 stage" })).toBeDefined();
    expect(api.remove).not.toHaveBeenCalled();
    const confirmButton = renderer.root.findByProps({ "aria-label": "确认删除 SSH 主机 stage" });
    await act(async () => { confirmButton.props.onClick(); await flushReactUpdates(); });

    expect(api.remove).toHaveBeenCalledWith(hosts[1].id);
    expect(list).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });
});

describe("SSH host creation", () => {
  it("offers optional jump host type and configured JumpServer choices", async () => {
    const jumpServer = { ...hosts[0], id: "system:fangcloud-jumpserver", alias: "fangcloud-jumpserver", hostname: "dev-jumpserver.fangcloud.net", port: 2222, user: "shenggangshu" };
    const { renderer } = await renderSshPage(vi.fn(), async () => ({ hosts: [hosts[0], jumpServer], diagnostics: [] }));
    const addButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("添加主机"))!;

    await act(async () => { addButton.props.onClick(); await flushReactUpdates(); });

    const dialog = renderer.root.findByProps({ role: "dialog" });
    const jumpType = dialog.findByProps({ "aria-label": "选择跳板机类型" });
    expect(dialog.findAllByType("select")).toHaveLength(0);
    await act(async () => { jumpType.props.onClick(); await flushReactUpdates(); });
    const jumpTypeOptions = dialog.findByProps({ role: "listbox", "aria-label": "选择跳板机类型" }).findAllByProps({ role: "option" });
    expect(jumpTypeOptions.map((option) => textContent(option))).toEqual(["不使用跳板机", "OpenSSH ProxyJump", "JumpServer"]);
    const stopPropagation = vi.fn();
    await act(async () => { jumpTypeOptions[2].props.onPointerDown({ preventDefault: vi.fn(), stopPropagation }); await flushReactUpdates(); });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(dialog.findAllByProps({ role: "listbox", "aria-label": "选择跳板机类型" })).toHaveLength(0);
    expect(dialog.findByProps({ "aria-label": "选择跳板机类型" }).props["aria-expanded"]).toBe(false);
    expect(textContent(dialog.findByProps({ "aria-label": "选择跳板机类型" }))).toContain("JumpServer");
    const jumpHost = dialog.findByProps({ "aria-label": "选择跳板机" });
    await act(async () => { jumpHost.props.onClick(); await flushReactUpdates(); });
    const jumpHostOptions = dialog.findByProps({ role: "listbox", "aria-label": "选择跳板机" }).findAllByProps({ role: "option" });
    expect(jumpHostOptions.map((option) => textContent(option))).toContain("fangcloud-jumpservershenggangshu@dev-jumpserver.fangcloud.net:2222");

    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("submits a selected JumpServer separately from ProxyJump", async () => {
    const jumpServer = { ...hosts[0], id: "system:fangcloud-jumpserver", alias: "fangcloud-jumpserver", hostname: "dev-jumpserver.fangcloud.net", port: 2222, user: "shenggangshu" };
    const { renderer, api } = await renderSshPage(vi.fn(), async () => ({ hosts: [hosts[0], jumpServer], diagnostics: [] }));
    api.add.mockResolvedValue({ ...hosts[1], id: "managed:private-app", alias: "private-app", hostname: "172.16.0.241" });
    const addButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("添加主机"))!;

    await act(async () => { addButton.props.onClick(); await flushReactUpdates(); });
    const dialog = renderer.root.findByProps({ role: "dialog" });
    const findInput = (placeholder: string) => dialog.findByProps({ placeholder });
    await act(async () => { findInput("例如：kg演示").props.onChange({ target: { value: "private-app" } }); });
    await act(async () => { findInput("172.16.0.241").props.onChange({ target: { value: "172.16.0.241" } }); });
    await act(async () => { dialog.findByProps({ "aria-label": "选择跳板机类型" }).props.onClick(); await flushReactUpdates(); });
    await act(async () => { dialog.findByProps({ role: "listbox", "aria-label": "选择跳板机类型" }).findAllByProps({ role: "option" })[2].props.onPointerDown({ preventDefault: vi.fn(), stopPropagation: vi.fn() }); await flushReactUpdates(); });
    await act(async () => { dialog.findByProps({ "aria-label": "选择跳板机" }).props.onClick(); await flushReactUpdates(); });
    await act(async () => { dialog.findByProps({ role: "listbox", "aria-label": "选择跳板机" }).findAllByProps({ role: "option" }).find((option) => textContent(option).startsWith("fangcloud-jumpserver"))!.props.onPointerDown({ preventDefault: vi.fn(), stopPropagation: vi.fn() }); await flushReactUpdates(); });
    await act(async () => { dialog.props.onSubmit({ preventDefault: vi.fn() }); await flushReactUpdates(); });

    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ alias: "private-app", hostname: "172.16.0.241", jumpHostType: "jumpserver", jumpHost: "fangcloud-jumpserver" }));
    expect(api.add.mock.calls[0][0]).not.toHaveProperty("proxyJump");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("saves an optional deployment password while adding a host", async () => {
    const { renderer, api, credentials } = await renderSshPage();
    const addedHost = { ...hosts[1], id: "managed:new", alias: "kg演示", hostname: "192.0.2.10", source: "managed" as const };
    api.add.mockResolvedValue(addedHost);

    const addButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("添加主机"))!;
    await act(async () => {
      addButton.props.onClick();
      await flushReactUpdates();
    });

    const dialog = renderer.root.findByProps({ role: "dialog" });
    const findInput = (placeholder: string) => dialog.findByProps({ placeholder });
    await act(async () => { findInput("例如：kg演示").props.onChange({ target: { value: "kg演示" } }); await flushReactUpdates(); });
    await act(async () => { findInput("172.16.0.241").props.onChange({ target: { value: "192.0.2.10" } }); await flushReactUpdates(); });
    await act(async () => { findInput("deploy").props.onChange({ target: { value: "deployer" } }); await flushReactUpdates(); });
    await act(async () => { dialog.findByProps({ type: "password" }).props.onChange({ target: { value: "new-host-password" } }); await flushReactUpdates(); });
    expect(dialog.findByProps({ type: "password" }).props.value).toBe("new-host-password");

    await act(async () => {
      dialog.props.onSubmit({ preventDefault: vi.fn() });
      await flushReactUpdates();
    });

    expect(api.add).toHaveBeenCalledWith({ alias: "kg演示", hostname: "192.0.2.10", port: 22, user: "deployer" });
    expect(credentials.set).toHaveBeenCalledWith({ hostId: addedHost.id, password: "new-host-password" });
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });
});

describe("SSH deployment actions", () => {
  it("does not expose deployment for untrusted or blocked hosts", async () => {
    for (const status of ["untrusted", "identity-changed", "invalid"] as const) {
      const blockedHost = { ...hosts[0], status };
      const { renderer } = await renderSshPage(vi.fn(), async () => ({ hosts: [blockedHost], diagnostics: [] }));
      expect(renderer.root.findAllByType("button").some((button) => textContent(button).includes("部署公钥"))).toBe(false);
      act(() => { renderer.unmount(); });
      vi.unstubAllGlobals();
      resetSshHostCache();
    }
  });

  it("keeps deployment onSession behavior for an auth-required host", async () => {
    const onSession = vi.fn();
    const authHost = { ...hosts[0], status: "auth-required" as const };
    const { renderer, api } = await renderSshPage(onSession, async () => ({ hosts: [authHost], diagnostics: [] }));
    const deploySession = { id: "deploy-1", hostId: authHost.id, alias: authHost.alias, kind: "deploy" as const, title: "部署公钥", state: "open" as const };
    api.deployKey.mockResolvedValue(deploySession);
    const deployButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "部署公钥")!;

    await act(async () => { deployButton.props.onClick(); await flushReactUpdates(); });
    expect(api.deployKey).toHaveBeenCalledWith(authHost.id);
    expect(onSession).toHaveBeenCalledWith(deploySession);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });
});
