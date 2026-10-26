import { beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-contract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  list: vi.fn(async () => ({
    executions: [{
      runId: "afk-158", workItemId: "github:acme/api#42",
      profileId: "default", attempt: 1, status: "running", sequence: 1, terminal: false,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }],
    nextCursor: "cursor-1",
  })),
  inventory: vi.fn(async () => ({ items: [], projects: [], diagnostics: [], complete: true })),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/afk-execution-ipc-test" },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
}));

vi.mock("../../electron/work-items/inventory-service.js", () => ({
  createWorkItemInventoryService: () => ({ list: mocks.inventory, sync: mocks.inventory }),
}));

vi.mock("../../electron/work-items/execution-query-service.js", () => ({
  createWorkItemExecutionQueryService: () => ({ list: mocks.list }),
}));

describe("execution IPC channel", () => {
  beforeAll(async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5174";
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers.js");
    registerIpcHandlers();
  });

  it("registers the audit query channel and forwards only audited executions", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.workItemsExecutions);
    expect(handler).toBeTypeOf("function");
    const result = await handler!({ senderFrame: { url: "http://localhost:5174" } }, {}) as {
      executions: Array<{ runId: string }>;
      nextCursor?: string;
    };
    expect(result.executions.map(execution => execution.runId)).toEqual(["afk-158"]);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.executions[0]).toHaveProperty("usage", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(result).not.toHaveProperty("legacyRuns");
  });
});
