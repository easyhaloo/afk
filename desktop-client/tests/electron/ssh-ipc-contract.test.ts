import { beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-contract";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  exposedApi: undefined as unknown,
  invoke: vi.fn().mockResolvedValue(undefined),
  listHosts: vi.fn().mockResolvedValue({ hosts: [], diagnostics: [] }),
  openExternal: vi.fn().mockResolvedValue({ terminal: "iterm2" }),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
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
  createSshService: () => ({ listHosts: mocks.listHosts, openExternal: mocks.openExternal }),
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
