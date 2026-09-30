import { describe, expect, it, vi } from "vitest";
import { createProviderWorkItemApplicationFacade, createWorkItemApplicationAdapter } from "../../electron/adapters/work-item-application-adapter";

const project = { platform: "github" as const, projectKey: "acme/api", name: "api" };
const item = {
  id: "github:acme/api#1", issueNumber: 1, project, title: "API issue",
  managed: true, executionEligible: true, state: "ready" as const, executionMode: "afk" as const,
  dependsOn: [], tags: ["urgent"], branchName: "afk/backlog-1", providerRef: "github:acme/api#1",
};

describe("work item application provider adapter", () => {
  it("queries the application with a provider snapshot and no CLI process", async () => {
    const loadSnapshot = vi.fn(async () => ({
      items: [item, { ...item, id: "github:acme/api#2", issueNumber: 2, state: "blocked" as const, tags: [] }],
      projects: [project], diagnostics: [], complete: true,
    }));
    const adapter = createWorkItemApplicationAdapter(createProviderWorkItemApplicationFacade({ loadSnapshot }));
    const result = await adapter.list({ platform: "github", state: "ready", executionMode: "afk", tag: "urgent", project: "acme/api" });
    expect(loadSnapshot).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledWith("github");
    expect(result.items).toEqual([item]);
    expect(result.projects).toEqual([project]);
  });

  it("keeps partial provider diagnostics and surfaces failures", async () => {
    const loadSnapshot = vi.fn(async () => ({
      items: [item], projects: [project],
      diagnostics: [{ platform: "github" as const, projectKey: "github.com", code: "project_list_failed", message: "rate limit", retryable: true }],
      complete: false,
    }));
    const adapter = createWorkItemApplicationAdapter(createProviderWorkItemApplicationFacade({ loadSnapshot }));
    await expect(adapter.list({ project: "acme/api" })).resolves.toMatchObject({ items: [item], complete: false, diagnostics: [{ code: "project_list_failed" }] });
    loadSnapshot.mockRejectedValueOnce(new Error("authentication required"));
    await expect(adapter.list()).rejects.toThrow("authentication required");
  });
});
