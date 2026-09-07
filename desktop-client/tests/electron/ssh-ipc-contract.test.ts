import { beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-contract";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  exposedApi: undefined as unknown,
  invoke: vi.fn().mockResolvedValue(undefined),
  listHosts: vi.fn().mockResolvedValue({ hosts: [], diagnostics: [] }),
  updateHost: vi.fn().mockResolvedValue({ id: "managed:build-box", alias: "build-box" }),
  deployKey: vi.fn().mockResolvedValue({ id: "session-deploy" }),
  openExternal: vi.fn().mockResolvedValue({ terminal: "iterm2" }),
  credentialHas: vi.fn().mockResolvedValue(false),
  credentialSet: vi.fn().mockResolvedValue(true),
  credentialRemove: vi.fn().mockResolvedValue(true),
  credentialService: undefined as unknown,
  serviceDependencies: undefined as unknown,
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => { mocks.exposedApi = api; },
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
  },
}));

vi.mock("../../electron/services/ssh-service", () => ({
  createSshService: (dependencies: unknown) => {
    mocks.serviceDependencies = dependencies;
    return {
      listHosts: mocks.listHosts,
      updateHost: mocks.updateHost,
      deployKey: mocks.deployKey,
      openExternal: mocks.openExternal,
      hasCredential: mocks.credentialHas,
      setCredential: mocks.credentialSet,
      removeCredential: mocks.credentialRemove,
    };
  },
}));

vi.mock("../../electron/services/ssh-credential-service", () => ({
  createSshCredentialService: () => {
    mocks.credentialService = { has: mocks.credentialHas, set: mocks.credentialSet, remove: mocks.credentialRemove };
    return mocks.credentialService;
  },
}));

describe("SSH external terminal IPC contract", () => {
  beforeAll(async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5174";
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers");
    registerIpcHandlers();
    await import("../../electron/preload");
  });

  it("registers a fixed external-terminal channel", () => {
    expect(IPC_CHANNELS.sshOpenExternal).toBe("afk:ssh-open-external");
    expect(mocks.handlers.has(IPC_CHANNELS.sshOpenExternal)).toBe(true);
  });

  it("registers and forwards managed-host updates through the fixed IPC channel", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshUpdate)!;
    const api = mocks.exposedApi as { ssh: { update: (hostId: string, input: unknown) => Promise<unknown> } };
    const input = { alias: "build-box", hostname: "build.example.test", port: 22 };
    const sender = { senderFrame: { url: "http://localhost:5174" } };
    mocks.updateHost.mockClear();
    mocks.invoke.mockClear();

    await expect(handler(sender, "managed:build-box", input)).resolves.toMatchObject({ id: "managed:build-box" });
    expect(mocks.updateHost).toHaveBeenCalledWith("managed:build-box", input);
    await api.ssh.update("managed:build-box", input);
    expect(mocks.invoke).toHaveBeenCalledWith(IPC_CHANNELS.sshUpdate, "managed:build-box", input);
  });

  it("validates managed-host update arguments at the IPC boundary", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshUpdate)!;
    const sender = { senderFrame: { url: "http://localhost:5174" } };

    await expect(Promise.resolve().then(() => handler(sender, "invalid", { alias: "build-box", hostname: "build.example.test", port: 22 }))).rejects.toThrow("SSH 主机 ID 无效");
    await expect(Promise.resolve().then(() => handler(sender, "managed:build-box", { alias: "bad alias", hostname: "build.example.test", port: 22 }))).rejects.toThrow("SSH 主机别名无效");
  });

  it("injects the created credential service into the SSH service", () => {
    const dependencies = mocks.serviceDependencies as { credentialService?: unknown };

    expect(dependencies.credentialService).toBe(mocks.credentialService);
  });

  it("rejects an untrusted sender before validating or opening a host", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshOpenExternal)!;

    await expect(Promise.resolve().then(() => handler({ senderFrame: { url: "https://attacker.example" } }, "not-a-host-id")))
      .rejects.toThrow("拒绝来自非 AFK Control renderer 的 IPC 请求");
  });

  it("validates hostId at the handler boundary", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshOpenExternal)!;

    await expect(Promise.resolve().then(() => handler({ senderFrame: { url: "http://localhost:5174" } }, "not-a-host-id")))
      .rejects.toThrow("SSH 主机 ID 无效");
  });

  it("forwards a legal hostId through the main-process handler", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshOpenExternal)!;
    mocks.openExternal.mockClear();

    await expect(handler({ senderFrame: { url: "http://localhost:5174" } }, "managed:build-box", "ghostty"))
      .resolves.toEqual({ terminal: "iterm2" });
    expect(mocks.openExternal).toHaveBeenCalledWith("managed:build-box", "ghostty");
  });

  it("forwards deploy-key requests through the injected SSH service", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshDeployKey)!;
    const sender = { senderFrame: { url: "http://localhost:5174" } };

    await expect(handler(sender, "managed:build-box")).resolves.toEqual({ id: "session-deploy" });
    expect(mocks.deployKey).toHaveBeenCalledWith("managed:build-box");
  });

  it("rejects an unknown external terminal at the IPC boundary", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshOpenExternal)!;
    mocks.openExternal.mockClear();

    await expect(Promise.resolve().then(() => handler({ senderFrame: { url: "http://localhost:5174" } }, "managed:build-box", "xterm")))
      .rejects.toThrow("SSH 外部终端无效");
    expect(mocks.openExternal).not.toHaveBeenCalledWith("managed:build-box", "xterm");
  });

  it("maps preload ssh.openExternal to the fixed IPC channel and hostId argument", async () => {
    const api = mocks.exposedApi as { ssh: { openExternal: (hostId: string, terminal: string) => Promise<unknown> } };
    mocks.invoke.mockClear();

    await api.ssh.openExternal("managed:build-box", "warp");

    expect(mocks.invoke).toHaveBeenCalledWith("afk:ssh-open-external", "managed:build-box", "warp");
  });

  it("keeps ssh.list compatible without arguments and forwards forceRefresh", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshList)!;
    const api = mocks.exposedApi as { ssh: { list: (options?: { forceRefresh?: boolean }) => Promise<unknown> } };
    mocks.listHosts.mockClear();
    mocks.invoke.mockClear();

    await handler({ senderFrame: { url: "http://localhost:5174" } });
    expect(mocks.listHosts).toHaveBeenCalledWith();

    mocks.listHosts.mockClear();
    await handler({ senderFrame: { url: "http://localhost:5174" } }, { forceRefresh: true });
    expect(mocks.listHosts).toHaveBeenCalledWith({ forceRefresh: true });

    await api.ssh.list({ forceRefresh: true });
    expect(mocks.invoke).toHaveBeenCalledWith("afk:ssh-list", { forceRefresh: true });
  });

  it("rejects unknown or non-boolean ssh.list options", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.sshList)!;
    const sender = { senderFrame: { url: "http://localhost:5174" } };
    mocks.listHosts.mockClear();

    await expect(Promise.resolve().then(() => handler(sender, { forceRefresh: "true" }))).rejects.toThrow("SSH 列表参数无效");
    await expect(Promise.resolve().then(() => handler(sender, { forceRefresh: true, unexpected: false }))).rejects.toThrow("SSH 列表参数无效");
    expect(mocks.listHosts).not.toHaveBeenCalledWith({ forceRefresh: true });
  });
});

describe("SSH credential IPC contract", () => {
  beforeAll(async () => {
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers");
    registerIpcHandlers();
    await import("../../electron/preload");
  });

  it("registers typed credential channels and exposes status management without get", () => {
    expect(IPC_CHANNELS.sshCredentialHas).toBe("afk:ssh-credential-has");
    expect(IPC_CHANNELS.sshCredentialSet).toBe("afk:ssh-credential-set");
    expect(IPC_CHANNELS.sshCredentialRemove).toBe("afk:ssh-credential-remove");
    expect(mocks.handlers.has(IPC_CHANNELS.sshCredentialHas)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.sshCredentialSet)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.sshCredentialRemove)).toBe(true);
    expect((mocks.exposedApi as { ssh: Record<string, unknown> }).ssh.credentialGet).toBeUndefined();
  });

  it("guards credential channels and validates hostId and password arguments", async () => {
    const hasHandler = mocks.handlers.get(IPC_CHANNELS.sshCredentialHas)!;
    const setHandler = mocks.handlers.get(IPC_CHANNELS.sshCredentialSet)!;
    const removeHandler = mocks.handlers.get(IPC_CHANNELS.sshCredentialRemove)!;
    const trusted = { senderFrame: { url: "http://localhost:5174" } };

    await expect(Promise.resolve().then(() => hasHandler({ senderFrame: { url: "https://attacker.example" } }, "managed:one"))).rejects.toThrow("拒绝来自非 AFK Control renderer 的 IPC 请求");
    await expect(Promise.resolve().then(() => hasHandler(trusted, "invalid"))).rejects.toThrow("SSH 主机 ID 无效");
    await expect(Promise.resolve().then(() => setHandler(trusted, { hostId: "managed:one", password: "bad\0password" }))).rejects.toThrow("SSH 部署密码无效");
    await expect(Promise.resolve().then(() => setHandler(trusted, { hostId: "managed:one", password: "bad\rpassword" }))).rejects.toThrow("SSH 部署密码无效");
    await expect(Promise.resolve().then(() => setHandler(trusted, { hostId: "managed:one", password: "bad\npassword" }))).rejects.toThrow("SSH 部署密码无效");
    await expect(Promise.resolve().then(() => setHandler(trusted, { hostId: "managed:one", password: "x".repeat(4097) }))).rejects.toThrow("SSH 部署密码无效");
    await expect(Promise.resolve().then(() => setHandler(trusted, { hostId: "managed:one", password: "ok", extra: true }))).rejects.toThrow("SSH 凭据参数无效");
    await expect(Promise.resolve().then(() => removeHandler(trusted, "managed:one"))).resolves.toBe(true);
  });

  it("forwards legal credential operations through typed IPC", async () => {
    const hasHandler = mocks.handlers.get(IPC_CHANNELS.sshCredentialHas)!;
    const setHandler = mocks.handlers.get(IPC_CHANNELS.sshCredentialSet)!;
    const removeHandler = mocks.handlers.get(IPC_CHANNELS.sshCredentialRemove)!;
    const trusted = { senderFrame: { url: "http://localhost:5174" } };

    mocks.credentialHas.mockClear();
    mocks.credentialSet.mockClear();
    mocks.credentialRemove.mockClear();
    await expect(hasHandler(trusted, "managed:one")).resolves.toBe(false);
    await expect(setHandler(trusted, { hostId: "managed:one", password: "ok" })).resolves.toBe(true);
    await expect(removeHandler(trusted, "managed:one")).resolves.toBe(true);
    expect(mocks.credentialHas).toHaveBeenCalledWith("managed:one");
    expect(mocks.credentialSet).toHaveBeenCalledWith("managed:one", "ok");
    expect(mocks.credentialRemove).toHaveBeenCalledWith("managed:one");
    expect(mocks.credentialService).not.toBeUndefined();
  });
});
