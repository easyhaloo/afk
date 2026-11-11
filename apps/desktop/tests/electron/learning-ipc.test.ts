import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopApi } from "../../shared/ipc-contract.js";

const mocks = vi.hoisted(() => {
  const dispatch = vi.fn(async (_action: string, _input: unknown): Promise<unknown> => []);
  return {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  api: undefined as DesktopApi | undefined,
  invoke: vi.fn(async (_channel: string, _input?: unknown) => undefined),
  dispatch,
  withRuntime: vi.fn(async (operation: (runtime: unknown) => Promise<unknown>) => operation({ dispatchSystemAction: dispatch })),
  inventory: vi.fn(async () => ({ items: [], projects: [{ platform: "github", projectKey: "acme/api" }], diagnostics: [], complete: true })),
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/learning-ipc-test" },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { mocks.api = api; } },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../../electron/work-items/inventory-service.js", () => ({
  createWorkItemInventoryService: () => ({ list: mocks.inventory, sync: mocks.inventory }),
}));
vi.mock("../../electron/services/plugin-service.js", () => ({ createPluginService: () => ({ withRuntime: mocks.withRuntime }) }));

const scope = "github:acme/api";
const candidateId = "a".repeat(64);
const trusted = { senderFrame: { url: "http://localhost:5174" } };
const selection = { scope, candidateId, expectedVersion: 1, checkerId: "verify.domain" };

function invoke(channel: string, input?: unknown, event: unknown = trusted) {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error("Missing learning IPC handler");
  return handler(event, input);
}

describe("learning Main and preload integration", () => {
  beforeAll(async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5174";
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers.js");
    registerIpcHandlers();
    const preload = "../../electron/preload.cts";
    await import(preload);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatch.mockImplementation(async action => action === "learning.jobs" ? [{ jobId: "b".repeat(64), scope, status: "blocked", attempts: [], sourceId: "PRIVATE_SOURCE" }] : []);
  });

  it("projects inventory without creating a runtime and sends reads through the owned runtime composition", async () => {
    expect(await invoke(IPC_CHANNELS.learningProjects)).toEqual([scope]);
    expect(mocks.withRuntime).not.toHaveBeenCalled();
    expect(await invoke(IPC_CHANNELS.learningJobs, { scope })).toEqual([{ jobId: "b".repeat(64), scope, status: "blocked", attemptCount: 0 }]);
    expect(mocks.withRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith("learning.jobs", { scope });
  });

  it("binds validation to the same scope, candidate and version and projects a bounded receipt", async () => {
    let version = 1;
    mocks.dispatch.mockImplementation(async action => {
      if (action === "learning.candidates") return [{ id: candidateId, requestKey: "c".repeat(64), version, state: version === 1 ? "candidate" : "validated",
        proposal: { kind: "fact", title: "Approval rule", evidenceIds: ["PRIVATE_EVIDENCE"], applicability: { project: scope } } }];
      if (action === "learning.validate") { version = 2; return { status: "validated", candidateId, candidateVersion: 1, validatedVersion: 2,
        executionId: "11111111-1111-4111-8111-111111111111", receiptDigest: "d".repeat(64) }; }
      throw new Error("Unexpected dispatch");
    });
    expect(await invoke(IPC_CHANNELS.learningValidate, selection)).toEqual({ status: "validated", candidateId, candidateVersion: 1, validatedVersion: 2 });
    expect(mocks.dispatch).toHaveBeenCalledWith("learning.validate", selection);
    expect(mocks.withRuntime).toHaveBeenCalledTimes(1);
  });

  it("rejects untrusted callers, foreign projects and injected execution inputs before dispatch", async () => {
    await expect(invoke(IPC_CHANNELS.learningJobs, { scope }, { senderFrame: { url: "https://untrusted.invalid" } })).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.learningJobs, { scope: "github:acme/foreign" })).rejects.toThrow("项目");
    for (const extra of [{ passed: true }, { command: "echo injected" }, { target: "/private" }]) {
      await expect(invoke(IPC_CHANNELS.learningValidate, { ...selection, ...extra })).rejects.toThrow();
    }
    expect(mocks.withRuntime).not.toHaveBeenCalled();
  });

  it("does not expose runtime errors or secrets across Main", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("PRIVATE_RUNTIME_SECRET"));
    await expect(invoke(IPC_CHANNELS.learningJobs, { scope })).rejects.toThrow("学习操作失败，请检查学习配置、候选版本与授权后重试。");
  });

  it("exposes exactly the fixed learning methods and matching wire channels", async () => {
    const api = mocks.api!.learning;
    expect(Object.keys(api).sort()).toEqual(["candidates", "jobs", "knowledge", "projects", "validate"]);
    expect(Object.keys(api.knowledge).sort()).toEqual(["prepare", "publish", "reconcile"]);
    await api.projects();
    await api.jobs({ scope });
    await api.candidates({ scope });
    await api.validate(selection);
    await api.knowledge.prepare({ scope, candidateId, expectedVersion: 1 });
    await api.knowledge.publish({ scope, key: "e".repeat(64) });
    await api.knowledge.reconcile({ scope });
    expect(mocks.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.learningProjects], [IPC_CHANNELS.learningJobs, { scope }], [IPC_CHANNELS.learningCandidates, { scope }],
      [IPC_CHANNELS.learningValidate, selection], [IPC_CHANNELS.learningKnowledgePrepare, { scope, candidateId, expectedVersion: 1 }],
      [IPC_CHANNELS.learningKnowledgePublish, { scope, key: "e".repeat(64) }], [IPC_CHANNELS.learningKnowledgeReconcile, { scope }],
    ]);
  });
});
