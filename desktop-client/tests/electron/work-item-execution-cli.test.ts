import { describe, expect, it } from "vitest";
import { createWorkItemExecutionService } from "../../electron/services/work-item-execution-service";
import type { GlobalWorkItem } from "../../shared/backlog-contract";

/**
 * The desktop and the CLI both drive the same execution runtime. The CLI
 * reaches it through `afk execute`, the desktop calls it in process; the
 * arguments they hand over have to describe the same execution.
 */
describe("single work-item execution", () => {
  it("hands the execution runtime the same identity the CLI parses from argv", async () => {
    const project = { platform: "github" as const, projectKey: "acme/api", name: "api" };
    const repository = { ...project, baseBranch: "main" };
    const item: GlobalWorkItem = {
      id: "github:easyhaloo/afk#158",
      issueNumber: 158,
      project,
      repositories: [repository],
      title: "Coordinate checkout changes",
      managed: true,
      executionEligible: true,
      state: "ready",
      executionMode: "afk",
      dependsOn: [],
      tags: [],
      branchName: "afk/work-item-158",
      providerRef: "github:easyhaloo/afk#158",
    };
    const calls: Array<{ workItemId: string; manifestPath: string; template?: string; executionId: string }> = [];
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item,
      workspace: {
        allocate: async () => ({ root: "/tmp/task", repositories: [{ project, path: "/tmp/task/repositories/api" }] }),
        updateRun: async () => undefined,
      },
      execute: async input => {
        calls.push(input);
        return { status: "done" };
      },
      manifestStore: { save: async () => undefined },
      runStore: { load: async () => [], save: async () => undefined },
    });

    const result = await service.start({
      workItemId: item.id,
      repositories: [{ ...project, checkoutPath: "repositories/api", baseBranch: "main" }],
      workflow: "default",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      workItemId: "github:easyhaloo/afk#158",
      manifestPath: "/tmp/task/.afk/execution-manifest.json",
      template: "default",
      executionId: result.runId,
    });
  });
});
