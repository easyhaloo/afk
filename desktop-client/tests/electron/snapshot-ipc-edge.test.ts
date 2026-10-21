import { beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-contract";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  snapshot: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/afk-user-data" },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  contextBridge: { exposeInMainWorld: () => {} },
  dialog: { showOpenDialog: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
  },
}));

// The services are assembled once, in the IPC layer, and the channels use
// the ones assembled there. The test replaces that layer so it can make
// the snapshot refuse.
vi.mock("../../electron/ipc/ipc-services", () => ({
  clipboardService: { copyText: vi.fn() },
  defaultJumpserverService: {},
  desktopService: { snapshot: mocks.snapshot, saveWorkflowConfig: vi.fn() },
  externalUrlService: { open: vi.fn() },
  resourceAdapter: { isAfkTmuxSession: () => false, listAfkTmux: async () => [] },
  workflowGraphService: { status: vi.fn(), generate: vi.fn() },
  sshService: {},
  backlogService: {},
  backlogExecutionService: {},
  backlogRuntimeService: {},
  executionAttachService: {},
  tmuxAttachPty: {},
  workItemExecutionQueryService: {},
  workItemExecutionService: {},
  workItemInventoryService: {},
  workItemInventorySyncService: { start: vi.fn(), stop: vi.fn() },
  workItemRunHistoryService: {},
}));

const trustedSender = { senderFrame: { url: "http://localhost:5174" } };

describe("snapshot channel", () => {
  beforeAll(async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5174";
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers");
    registerIpcHandlers();
  });

  it("never hands a snapshot that broke the contract to the renderer", async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error("快照数据不符合契约：loop.execution.active：Expected number, received string"));
    const handler = mocks.handlers.get(IPC_CHANNELS.snapshot)!;

    await expect(Promise.resolve().then(() => handler(trustedSender, process.cwd())))
      .rejects.toThrow(/快照数据不符合契约：loop\.execution\.active/);
    expect(mocks.snapshot).toHaveBeenCalled();
  });

  it("keeps serving the other channels after a refused snapshot", async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error("快照数据不符合契约：loop.execution.active：Expected number, received string"));
    await expect(Promise.resolve().then(() => mocks.handlers.get(IPC_CHANNELS.snapshot)!(trustedSender, process.cwd()))).rejects.toThrow();

    const appearance = mocks.handlers.get(IPC_CHANNELS.appearance)!;
    await expect(Promise.resolve().then(() => appearance(trustedSender, undefined))).resolves.toMatchObject({ theme: expect.any(String) });
  });
});
