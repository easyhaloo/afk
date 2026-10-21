import { describe, expect, it, vi } from "vitest";

/**
 * "Did this execution finish the work?" is one question, and the
 * execution runtime and the desktop client both answer it. The runtime
 * owns the statuses an outcome can carry; the desktop used to name the
 * five states itself and to decide for itself which two of them mean
 * success.
 *
 * This test grows the runtime's set of successful statuses and then asks
 * the desktop whether it grew with it. A desktop that keeps its own
 * answer calls a successful run a failure, and the board shows a run
 * that finished as one that did not.
 */
vi.mock("@afk/execution", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/execution")>();
  const successes = [...original.EXECUTE_WORK_ITEM_SUCCESS_STATUSES, "published"];
  return {
    ...original,
    EXECUTE_WORK_ITEM_SUCCESS_STATUSES: successes,
    isSuccessfulExecuteWorkItemStatus: (status: string) => successes.includes(status as never),
  };
});

import { EXECUTE_WORK_ITEM_SUCCESS_STATUSES } from "@afk/execution";
import { createWorkItemExecutionService } from "../../desktop-client/electron/services/work-item-execution-service";
import type { WorkItemRunRecord } from "../../desktop-client/shared/backlog-contract";

const apiProject = { platform: "github", projectKey: "acme/api", providerProjectId: "101", name: "api-service", role: "backend", baseBranch: "main" } as const;
const apiSelection = { ...apiProject, checkoutPath: "repositories/api", baseBranch: "main", role: "backend" } as const;

async function runWithOutcome(status: string): Promise<string[]> {
  const written: string[] = [];
  const service = createWorkItemExecutionService({
    getWorkItem: async () => ({
      id: "github:acme/api#42",
      issueNumber: 42,
      project: apiProject,
      title: "Coordinate checkout changes",
      managed: true,
      executionEligible: true,
      state: "ready",
      executionMode: "afk",
      dependsOn: [],
      tags: [],
      branchName: "afk/42",
      providerRef: "github:acme/api#42",
    }) as never,
    workspace: {
      allocate: async () => ({ root: "/tmp/afk-task", repositories: [{ project: apiProject, path: "/tmp/afk-task/repositories/api" }] }) as never,
      updateRun: vi.fn(async () => undefined),
    },
    execute: async () => ({ status } as never),
    manifestStore: { save: vi.fn(async () => undefined) },
    runStore: {
      load: async () => [],
      save: async () => undefined,
      update: async (_root: string, transform: (current: WorkItemRunRecord[]) => WorkItemRunRecord[] | Promise<WorkItemRunRecord[] | undefined> | undefined) => {
        const next = await transform([]);
        if (next) written.push(...next.map(record => record.status));
      },
    },
  });

  await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
  // The execution settles in the background of the main process; the
  // record is written when it does.
  await new Promise(resolve => setTimeout(resolve, 10));
  return written;
}

describe("the desktop answers with the runtime's idea of a successful execution", () => {
  it("calls every status the runtime calls a success a success", async () => {
    for (const status of EXECUTE_WORK_ITEM_SUCCESS_STATUSES) {
      expect(await runWithOutcome(status)).not.toContain("failed");
    }
  });

  it("calls a status the runtime does not call a success a failure", async () => {
    expect(await runWithOutcome("rework")).toContain("failed");
  });
});
