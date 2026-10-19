import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklogManagementProvider } from "@afk/application";
import { BacklogServiceError } from "../../electron/services/backlog-error";
import { createBacklogService, type BacklogServiceDeps } from "../../electron/services/backlog-service";
import type { BacklogItem } from "../../shared/backlog-contract";

function stubItem(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id, title: `task ${id}`, description: "demo",
    parentId: undefined, baseBacklogId: undefined, dependsOn: [],
    state: "ready", executionMode: "afk", tags: [],
    branchName: `afk/backlog-${id}`, providerRef: `stub:${id}`,
    ...overrides,
  };
}

type StubProvider = BacklogManagementProvider & {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  addTag: ReturnType<typeof vi.fn>;
  removeTag: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<BacklogServiceDeps> = {}): {
  deps: BacklogServiceDeps;
  provider: StubProvider;
  providers: ReturnType<typeof vi.fn>;
} {
  const provider: StubProvider = {
    get: vi.fn(async (id: string) => stubItem(id)),
    list: vi.fn(async () => [stubItem("1"), stubItem("2")]),
    create: vi.fn(async (input: { title: string }) => stubItem("new", { title: input.title })),
    addTag: vi.fn(async () => undefined),
    removeTag: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
  };
  const providers = vi.fn(async () => provider);
  const deps: BacklogServiceDeps = {
    providers: providers as unknown as BacklogServiceDeps["providers"],
    resolveWorkspace: (input: string) => input,
    ...overrides,
  };
  return { deps, provider, providers };
}

afterEach(() => vi.useRealTimers());

describe("backlog service: list", () => {
  it("asks the workspace provider for the backlog items", async () => {
    const { deps, provider } = makeDeps();
    const items = await createBacklogService(deps).list("/workspace");
    expect(items).toEqual([stubItem("1"), stubItem("2")]);
    expect(provider.list).toHaveBeenCalledWith({});
  });

  it("forwards the list filters to the use case", async () => {
    const { deps, provider } = makeDeps();
    await createBacklogService(deps).list("/workspace", {
      state: "ready",
      executionMode: "hitl",
      parentId: "epic-7",
      tag: "billing",
      platform: "github",
    });
    expect(provider.list).toHaveBeenCalledWith({
      state: "ready",
      executionMode: "hitl",
      parentId: "epic-7",
      tag: "billing",
    });
  });

  it("selects the provider for the requested platform", async () => {
    const { deps, providers } = makeDeps();
    await createBacklogService(deps).list("/workspace", { platform: "gitlab" });
    expect(providers).toHaveBeenCalledWith("/workspace", "gitlab");
  });

  it("translates a provider failure into a BacklogServiceError", async () => {
    const { deps, provider } = makeDeps();
    provider.list.mockRejectedValue(new Error("missing GITHUB_TOKEN"));
    const service = createBacklogService(deps);
    await expect(service.list("/workspace")).rejects.toBeInstanceOf(BacklogServiceError);
    await expect(service.list("/workspace")).rejects.toMatchObject({ code: "auth" });
  });

  it("classifies a not-found provider failure", async () => {
    const { deps, provider } = makeDeps();
    provider.get.mockRejectedValueOnce(new Error("backlog item not found: 42"));
    await expect(createBacklogService(deps).show("/workspace", "42")).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns 30s-cached items without asking the provider again", async () => {
    const { deps, provider } = makeDeps();
    const service = createBacklogService(deps);
    const first = await service.list("/workspace");
    const second = await service.list("/workspace");
    expect(first).toBe(second);
    expect(provider.list).toHaveBeenCalledTimes(1);
  });

  it("treats different (workspace, options, platform) tuples as separate cache keys", async () => {
    const { deps, provider } = makeDeps();
    const service = createBacklogService(deps);
    await service.list("/workspace-a");
    await service.list("/workspace-b");
    await service.list("/workspace-a", { platform: "github" });
    expect(provider.list).toHaveBeenCalledTimes(3);
  });

  it("expires cache entries after the configured TTL", async () => {
    vi.useFakeTimers();
    const { deps, provider } = makeDeps();
    const service = createBacklogService(deps, { ttlMs: 1000 });
    await service.list("/workspace");
    vi.advanceTimersByTime(1001);
    await service.list("/workspace");
    expect(provider.list).toHaveBeenCalledTimes(2);
  });
});

describe("backlog service: write operations invalidate list cache", () => {
  beforeEach(() => vi.useRealTimers());

  it("create invalidates the list cache", async () => {
    const { deps, provider } = makeDeps();
    const service = createBacklogService(deps);
    const before = await service.list("/workspace");
    const created = await service.create("/workspace", { title: "fresh", description: "desc" });
    const after = await service.list("/workspace");
    expect(created.id).toBe("new");
    expect(before).not.toBe(after);
    expect(provider.list).toHaveBeenCalledTimes(2);
  });

  it("addTag invalidates the list cache", async () => {
    const { deps, provider } = makeDeps();
    const service = createBacklogService(deps);
    await service.list("/workspace");
    await service.addTag("/workspace", "1", "urgent");
    await service.list("/workspace");
    expect(provider.addTag).toHaveBeenCalledWith("1", "urgent");
    expect(provider.list).toHaveBeenCalledTimes(2);
  });
});

describe("backlog service: show / create / addTag / removeTag", () => {
  it("show asks the provider for one item", async () => {
    const { deps, provider } = makeDeps();
    const item = await createBacklogService(deps).show("/workspace", "42");
    expect(item.id).toBe("42");
    expect(provider.get).toHaveBeenCalledWith("42");
  });

  it("create forwards every supported relationship, mode and tag", async () => {
    const { deps, provider } = makeDeps();
    const item = await createBacklogService(deps).create("/workspace", {
      title: "fresh",
      description: "demo",
      parentId: "epic-7",
      baseBacklogId: "base-3",
      dependsOn: ["dep-1", "dep-2"],
      executionMode: "hitl",
      tags: ["billing", "urgent"],
      platform: "gitlab",
    });
    expect(item.id).toBe("new");
    expect(provider.create).toHaveBeenCalledWith({
      title: "fresh",
      description: "demo",
      parentId: "epic-7",
      baseBacklogId: "base-3",
      dependsOn: ["dep-1", "dep-2"],
      executionMode: "hitl",
      tags: ["billing", "urgent"],
    });
  });

  it("addTag writes the tag and returns the updated item", async () => {
    const { deps, provider } = makeDeps();
    provider.get.mockResolvedValueOnce(stubItem("1", { tags: ["x"] }));
    const item = await createBacklogService(deps).addTag("/workspace", "1", "x");
    expect(item.tags).toEqual(["x"]);
    expect(provider.addTag).toHaveBeenCalledWith("1", "x");
  });

  it("removeTag writes the tag removal and returns the updated item", async () => {
    const { deps, provider } = makeDeps();
    provider.get.mockResolvedValueOnce(stubItem("1", { tags: [] }));
    const item = await createBacklogService(deps).removeTag("/workspace", "1", "x");
    expect(item.tags).toEqual([]);
    expect(provider.removeTag).toHaveBeenCalledWith("1", "x");
  });

  it("rejects an empty id before touching the provider", async () => {
    const { deps, provider } = makeDeps();
    await expect(createBacklogService(deps).show("/workspace", "")).rejects.toMatchObject({ code: "validation" });
    expect(provider.get).not.toHaveBeenCalled();
  });

  it("rejects a create without a title or description", async () => {
    const { deps, provider } = makeDeps();
    const service = createBacklogService(deps);
    await expect(service.create("/workspace", { title: " ", description: "demo" })).rejects.toMatchObject({ code: "validation" });
    await expect(service.create("/workspace", { title: "fresh", description: " " })).rejects.toMatchObject({ code: "validation" });
    expect(provider.create).not.toHaveBeenCalled();
  });
});
