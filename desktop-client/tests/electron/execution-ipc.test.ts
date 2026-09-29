import { beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-contract";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  list: vi.fn(async () => ({
    executions: [{
      executionId: "execution-158", runId: "afk-158", workItemId: "github:acme/api#42",
      project: { platform: "github", projectKey: "acme/api", name: "api" },
      status: "verifying", startedAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:01:00.000Z",
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

vi.mock("../../electron/services/work-item-inventory-service", () => ({
  createWorkItemInventoryService: () => ({ list: mocks.inventory, sync: mocks.inventory }),
}));

vi.mock("../../electron/services/work-item-execution-query-service", () => ({
  createWorkItemExecutionQueryService: () => ({ list: mocks.list }),
}));

describe("execution IPC channel", () => {
  beforeAll(async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5174";
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers");
    registerIpcHandlers();
  });

  it("registers the audit query channel and forwards only audited executions", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.workItemsExecutions);
    expect(handler).toBeTypeOf("function");
    const result = await handler!({ senderFrame: { url: "http://localhost:5174" } }, {}) as {
      executions: Array<{ executionId: string }>;
      nextCursor?: string;
    };
    expect(result.executions.map(execution => execution.executionId)).toEqual(["execution-158"]);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result).not.toHaveProperty("legacyRuns");
  });
});
