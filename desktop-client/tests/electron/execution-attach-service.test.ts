import { describe, expect, it } from "vitest";
import { createExecutionAttachService } from "../../electron/services/execution-attach-service.js";
import type { AfkResourceRecord } from "@afk/execution/infrastructure/runtime/resource-registry";

const row = (overrides: Partial<AfkResourceRecord> = {}): AfkResourceRecord => ({
  id: "resource-1",
  resourceKey: "resource-1",
  kind: "tmux",
  status: "active",
  name: "afk-run",
  externalId: undefined,
  detail: undefined,
  workspacePath: "/workspace",
  runId: "run-1",
  worktreePath: "/workspace/.afk/worktrees/run-1",
  origin: "local-sandbox",
  metadata: { tmuxSession: "afk-run", tmuxWindowId: "1", tmuxPaneId: "%0" },
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...overrides,
});

describe("execution attach service", () => {
  it("resolves only the registered exact tmux target", async () => {
    const checked: string[] = [];
    const service = createExecutionAttachService({
      readRunResources: runId => runId === "run-1" ? [row()] : [],
      verifyTargetExists: async target => { checked.push(target); return true; },
    });

    await expect(service.resolve("run-1")).resolves.toMatchObject({
      available: true,
      attachTarget: "afk-run:1.%0",
    });
    expect(checked).toEqual(["afk-run:1.%0"]);
    await expect(service.resolve("missing")).resolves.toEqual({
      available: false,
      unavailable: { runId: "missing", reason: "该运行没有已登记的执行环境资源" },
    });
  });

  it("keeps historical or closed resources unavailable", async () => {
    const service = createExecutionAttachService({
      readRunResources: () => [row({ status: "closed" })],
      verifyTargetExists: async () => true,
    });
    await expect(service.resolve("run-1")).resolves.toMatchObject({ available: false });
  });

  it("pins the selected resource without falling back to another phase or run", async () => {
    const service = createExecutionAttachService({
      readRunResources: () => [
        row(),
        row({ id: "resource-2", metadata: { tmuxSession: "verify", tmuxWindowId: "2", tmuxPaneId: "%3" } }),
        row({ id: "other-run", runId: "run-2" }),
      ],
      verifyTargetExists: async () => true,
    });
    await expect(service.resolve("run-1", "resource-2")).resolves.toMatchObject({ available: true, attachTarget: "verify:2.%3" });
    await expect(service.resolve("run-1", "missing")).resolves.toMatchObject({ available: false });
    await expect(service.resolve("run-1", "other-run")).resolves.toMatchObject({ available: false });
  });
});
