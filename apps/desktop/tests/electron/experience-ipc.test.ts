import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopApi } from "../../shared/ipc-contract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  api: undefined as DesktopApi | undefined,
  invoke: vi.fn(async (_channel: string, _input?: unknown) => undefined),
  outcomes: vi.fn(() => []), close: vi.fn(),
  inventory: vi.fn(async () => ({ items: [], projects: [{ platform: "github", projectKey: "acme/api" }], diagnostics: [], complete: true })),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/experience-ipc-test" }, BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() }, dialog: { showOpenDialog: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { mocks.api = api; } },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../../electron/work-items/inventory-service.js", () => ({
  createWorkItemInventoryService: () => ({ list: mocks.inventory, sync: mocks.inventory }),
}));
vi.mock("@afk/runtime/execution", async importOriginal => ({
  ...await importOriginal<typeof import("@afk/runtime/execution")>(),
  ExperienceStore: class {
    outcomeReceipts = mocks.outcomes;
    close = mocks.close;
  },
}));

const input = { scope: "github:acme/api", runId: "consumer", workItemId: "github:acme/api#2" };
function invoke(inputValue: unknown = input, event: unknown = { senderFrame: { url: "http://localhost:5174" } }) {
  const handler = mocks.handlers.get(IPC_CHANNELS.experiencesOutcomes);
  if (!handler) throw new Error("Missing experience outcome IPC handler");
  return handler(event, inputValue);
}

describe("experience outcome Main and preload integration", () => {
  beforeAll(async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5174";
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers.js");
    registerIpcHandlers();
    const preload = "../../electron/preload.cts";
    await import(preload);
  });
  beforeEach(() => { vi.clearAllMocks(); });

  it("registers a fixed validated channel that queries and closes the store", async () => {
    expect(await invoke()).toEqual([]);
    expect(mocks.outcomes).toHaveBeenCalledWith({ scope: input.scope, source: { runId: input.runId, workItemId: input.workItemId }, limit: 20 });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.inventory).toHaveBeenCalledTimes(2);
  });

  it("rejects untrusted senders, unknown inputs and cross-scope identities before storage access", async () => {
    await expect(invoke(input, { senderFrame: { url: "https://untrusted.invalid" } })).rejects.toThrow();
    for (const change of [{ secret: "private" }, { limit: 101 }, { runId: "" }, { workItemId: "github:acme/other#2" },
      { scope: "github:acme/other", workItemId: "github:acme/other#2" }]) {
      await expect(invoke({ ...input, ...change })).rejects.toThrow();
    }
    expect(mocks.outcomes).not.toHaveBeenCalled();
  });

  it("exposes only the fixed experience methods and matching outcome wire channel", async () => {
    const api = mocks.api!.experiences;
    expect(Object.keys(api).sort()).toEqual(["list", "outcomes", "projects", "revoke", "verify"]);
    await api.outcomes(input);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith(IPC_CHANNELS.experiencesOutcomes, input);
  });
});
