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
    credentialHas: credentials.has,
    credentialSet: credentials.set,
    credentialRemove: credentials.remove,
  };
  const confirm = vi.fn(() => false);
  vi.stubGlobal("window", { afkDesktop: { ssh: api }, confirm });
  return { api, connect, openExternal, list, confirm, credentials };
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

describe("SSH connection modes", () => {
  it("shows one terminal selector with built-in and external choices", async () => {
    const { renderer } = await renderSshPage();
    const selector = renderer.root.findByProps({ "aria-label": "选择 SSH 终端" });
    await act(async () => { selector.props.onClick(); });
    const listbox = renderer.root.findByProps({ role: "listbox" });
    const options = listbox.findAllByProps({ role: "option" });
    const labels = options.map((option) => textContent(option.findByType("b")));

    expect(labels).toEqual(["内置终端", "iTerm2", "Warp", "Ghostty", "cmux", "Terminal.app"]);
    expect(options.every((option) => option.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("ssh-terminal-icon")).length === 1)).toBe(true);
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
    const pageWindow = globalThis.window as unknown as { confirm: ReturnType<typeof vi.fn> };
    pageWindow.confirm.mockReturnValue(true);
    const managedHost = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row") && textContent(node).includes("stage"))[0];
    await act(async () => { managedHost.props.onClick(); });
    const removeButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "删除")!;

    await act(async () => { removeButton.props.onClick(); await flushReactUpdates(); });
    expect(api.remove).toHaveBeenCalledWith(hosts[1].id);
    expect(list).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });
});

describe("SSH host creation", () => {
  it("saves an optional deployment password while adding a host", async () => {
    const { renderer, api, credentials } = await renderSshPage();
    const addedHost = { ...hosts[1], id: "managed:new", alias: "new-host", hostname: "192.0.2.10", source: "managed" as const };
    api.add.mockResolvedValue(addedHost);

    const addButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("添加主机"))!;
    await act(async () => {
      addButton.props.onClick();
      await flushReactUpdates();
    });

    const dialog = renderer.root.findByProps({ role: "dialog" });
    const findInput = (placeholder: string) => dialog.findByProps({ placeholder });
    await act(async () => { findInput("production-web").props.onChange({ target: { value: "new-host" } }); await flushReactUpdates(); });
    await act(async () => { findInput("203.0.113.10").props.onChange({ target: { value: "192.0.2.10" } }); await flushReactUpdates(); });
    await act(async () => { findInput("deploy").props.onChange({ target: { value: "deployer" } }); await flushReactUpdates(); });
    await act(async () => { dialog.findByProps({ type: "password" }).props.onChange({ target: { value: "new-host-password" } }); await flushReactUpdates(); });

    await act(async () => {
      dialog.props.onSubmit({ preventDefault: vi.fn() });
      await flushReactUpdates();
    });

    expect(api.add).toHaveBeenCalledWith({ alias: "new-host", hostname: "192.0.2.10", port: 22, user: "deployer" });
    expect(credentials.set).toHaveBeenCalledWith({ hostId: addedHost.id, password: "new-host-password" });
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });
});

describe("SSH deployment credentials", () => {
  it("keeps password management recoverable when credential status loading fails", async () => {
    const harness = createSshPageHarness();
    const pendingStatus = deferred<boolean>();
    const statusCall = deferred<void>();
    harness.credentials.has.mockImplementationOnce(() => {
      statusCall.resolve(undefined);
      return pendingStatus.promise;
    });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(SshHostsPage, { onSession: vi.fn() }));
      await flushReactUpdates();
    });
    await statusCall.promise;
    await act(async () => {
      pendingStatus.reject(new Error("读取部署密码失败"));
      await pendingStatus.promise.catch(() => undefined);
      await flushReactUpdates();
    });

    expect(textContent(renderer!.root.findByProps({ "aria-label": "部署密码" }))).toContain("读取失败");
    const retryButton = renderer!.root.findAllByType("button").find((button) => textContent(button) === "重试读取")!;
    expect(retryButton).toBeDefined();
    const saveButton = renderer!.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!;
    expect(saveButton.props.disabled).toBe(false);

    await act(async () => {
      retryButton.props.onClick();
      await flushReactUpdates();
    });
    expect(harness.credentials.has).toHaveBeenCalledTimes(2);
    expect(textContent(renderer!.root.findByProps({ "aria-label": "部署密码" }))).toContain("未设置");

    act(() => { renderer!.unmount(); });
    vi.unstubAllGlobals();
  });

  it("loads only the saved status and never renders the password", async () => {
    const { renderer, credentials } = await renderSshPage();

    expect(credentials.has).toHaveBeenCalledWith(hosts[0].id);
    expect(textContent(renderer.root)).toContain("未设置");
    expect(textContent(renderer.root)).not.toContain("secret-password");
    expect(renderer.root.findAll((node) => node.props.type === "password")).toHaveLength(1);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("rejects blank passwords and saves a non-blank password through the typed credentials API", async () => {
    const { renderer, credentials } = await renderSshPage();
    const passwordInput = renderer.root.findByProps({ type: "password" });
    const saveButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!;

    await act(async () => {
      passwordInput.props.onChange({ target: { value: "   " } });
      await flushReactUpdates();
    });
    await act(async () => { saveButton.props.onClick(); await flushReactUpdates(); });
    expect(credentials.set).not.toHaveBeenCalled();
    expect(textContent(renderer.root.findByProps({ role: "alert" }))).toContain("密码不能为空");

    await act(async () => {
      passwordInput.props.onChange({ target: { value: "secret-password" } });
      await flushReactUpdates();
    });
    await act(async () => { saveButton.props.onClick(); await flushReactUpdates(); });
    expect(credentials.set).toHaveBeenCalledWith({ hostId: hosts[0].id, password: "secret-password" });
    expect(credentials.has).toHaveBeenCalledTimes(2);
    expect(textContent(renderer.root)).toContain("已保存");
    expect(textContent(renderer.root)).not.toContain("secret-password");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("removes a saved password and refreshes only its status", async () => {
    const { renderer, credentials } = await renderSshPage();
    const passwordInput = renderer.root.findByProps({ type: "password" });
    const saveButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!;
    await act(async () => {
      passwordInput.props.onChange({ target: { value: "secret-password" } });
      await flushReactUpdates();
    });
    await act(async () => { saveButton.props.onClick(); await flushReactUpdates(); });

    const removeButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "删除已保存密码")!;
    await act(async () => { removeButton.props.onClick(); await flushReactUpdates(); });
    expect(credentials.remove).toHaveBeenCalledWith(hosts[0].id);
    expect(credentials.has).toHaveBeenCalledTimes(3);
    expect(textContent(renderer.root)).toContain("未设置");
    expect(passwordInput.props.value).toBe("");
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("does not apply a pending password save result after switching hosts", async () => {
    const pendingSave = deferred<boolean>();
    const pendingStatus = deferred<boolean>();
    const { renderer, credentials } = await renderSshPage();
    credentials.set.mockImplementationOnce(() => pendingSave.promise);
    credentials.has.mockImplementation(async (hostId) => hostId === hosts[0].id ? pendingStatus.promise : false);
    const passwordInput = renderer.root.findByProps({ type: "password" });
    const saveButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!;

    await act(async () => {
      passwordInput.props.onChange({ target: { value: "prod-password" } });
      saveButton.props.onClick();
      await flushReactUpdates();
    });
    const stageHost = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row") && textContent(node).includes("stage"))[0];
    await act(async () => {
      stageHost.props.onClick();
      await flushReactUpdates();
    });
    const stagePasswordInput = renderer.root.findByProps({ type: "password" });
    await act(async () => {
      stagePasswordInput.props.onChange({ target: { value: "stage-password" } });
      await flushReactUpdates();
    });
    expect(renderer.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!.props.disabled).toBe(false);

    await act(async () => {
      pendingSave.resolve(true);
      await pendingSave.promise;
      await flushReactUpdates();
    });
    expect(credentials.has).toHaveBeenCalledWith(hosts[0].id);
    await act(async () => {
      pendingStatus.resolve(true);
      await pendingStatus.promise;
      await flushReactUpdates();
    });

    expect(textContent(renderer.root.findByProps({ "aria-label": "部署密码" }))).toContain("未设置");
    expect(renderer.root.findByProps({ type: "password" }).props.value).toBe("stage-password");
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => textContent(node).includes("部署密码已保存"))).toBe(false);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("does not show a pending password save failure after switching hosts", async () => {
    const pendingSave = deferred<boolean>();
    const { renderer, credentials } = await renderSshPage();
    credentials.set.mockImplementationOnce(() => pendingSave.promise);
    const saveFailure = pendingSave.promise.catch(() => undefined);
    const passwordInput = renderer.root.findByProps({ type: "password" });
    const saveButton = renderer.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!;

    await act(async () => {
      passwordInput.props.onChange({ target: { value: "prod-password" } });
      saveButton.props.onClick();
      await flushReactUpdates();
    });
    const stageHost = renderer.root.findAll((node) => node.props.className?.includes("ssh-host-row") && textContent(node).includes("stage"))[0];
    await act(async () => {
      stageHost.props.onClick();
      await flushReactUpdates();
    });
    const stagePasswordInput = renderer.root.findByProps({ type: "password" });
    await act(async () => {
      stagePasswordInput.props.onChange({ target: { value: "stage-password" } });
      await flushReactUpdates();
    });

    await act(async () => {
      pendingSave.reject(new Error("prod 保存失败"));
      await saveFailure;
      await flushReactUpdates();
    });

    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(renderer.root.findByProps({ type: "password" }).props.value).toBe("stage-password");
    expect(renderer.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!.props.disabled).toBe(false);
    act(() => { renderer.unmount(); });
    vi.unstubAllGlobals();
  });

  it("does not apply a pending password removal result after switching hosts", async () => {
    const pendingRemove = deferred<boolean>();
    const pendingStatus = deferred<boolean>();
    const harness = createSshPageHarness();
    harness.credentials.has.mockResolvedValue(true);
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(SshHostsPage, { onSession: vi.fn() }));
      await flushReactUpdates();
    });
    harness.credentials.remove.mockImplementationOnce(() => pendingRemove.promise);
    harness.credentials.has.mockImplementation(async (hostId) => hostId === hosts[0].id ? pendingStatus.promise : false);
    const removeButton = renderer!.root.findAllByType("button").find((button) => textContent(button) === "删除已保存密码")!;

    await act(async () => {
      removeButton.props.onClick();
      await flushReactUpdates();
    });
    const stageHost = renderer!.root.findAll((node) => node.props.className?.includes("ssh-host-row") && textContent(node).includes("stage"))[0];
    await act(async () => {
      stageHost.props.onClick();
      await flushReactUpdates();
    });
    const stagePasswordInput = renderer!.root.findByProps({ type: "password" });
    await act(async () => {
      stagePasswordInput.props.onChange({ target: { value: "stage-password" } });
      await flushReactUpdates();
    });

    await act(async () => {
      pendingRemove.resolve(true);
      await pendingRemove.promise;
      await flushReactUpdates();
    });
    expect(harness.credentials.has).toHaveBeenCalledWith(hosts[0].id);
    await act(async () => {
      pendingStatus.resolve(true);
      await pendingStatus.promise;
      await flushReactUpdates();
    });

    expect(textContent(renderer!.root.findByProps({ "aria-label": "部署密码" }))).toContain("未设置");
    expect(renderer!.root.findByProps({ type: "password" }).props.value).toBe("stage-password");
    expect(renderer!.root.findAllByProps({ role: "status" }).some((node) => textContent(node).includes("已删除部署密码"))).toBe(false);
    expect(renderer!.root.findAllByType("button").find((button) => textContent(button) === "保存部署密码")!.props.disabled).toBe(false);
    act(() => { renderer!.unmount(); });
    vi.unstubAllGlobals();
  });

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
