import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeDeps(overrides: Partial<BacklogServiceDeps> = {}): { deps: BacklogServiceDeps; execMock: ReturnType<typeof vi.fn> } {
  const execMock = vi.fn();
  const deps: BacklogServiceDeps = {
    resolveAfk: async () => "/usr/local/bin/afk",
    resolveWorkspace: (input: string) => input,
    exec: execMock as BacklogServiceDeps["exec"],
    ...overrides,
  };
  return { deps, execMock };
}

afterEach(() => vi.useRealTimers());

describe("backlog service: list", () => {
  it("parses the JSON success envelope and forwards options as --flags", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("1"), stubItem("2")] }),
      stderr: "",
    });
    const service = createBacklogService(deps);
    const items = await service.list("/workspace", {
      state: "ready",
      executionMode: "hitl",
      parentId: "epic-7",
      tag: "billing",
      platform: "github",
    });
    expect(items).toEqual([stubItem("1"), stubItem("2")]);
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toEqual([
      "backlog", "list",
      "--state", "ready",
      "--mode", "hitl",
      "--parent", "epic-7",
      "--tag", "billing",
      "--platform", "github",
      "--json",
    ]);
  });

  it("parses the JSON failure envelope and throws BacklogServiceError", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ ok: false, kind: "backlog.list", error: { code: "auth", message: "missing GITHUB_TOKEN" } }),
      stderr: "",
    });
    const service = createBacklogService(deps);
    await expect(service.list("/workspace")).rejects.toBeInstanceOf(BacklogServiceError);
    await expect(service.list("/workspace")).rejects.toMatchObject({ code: "auth" });
  });

  it.each([
    { label: "non-object", payload: "[]" },
    { label: "missing kind", payload: JSON.stringify({ ok: true, data: [] }) },
    { label: "missing success data", payload: JSON.stringify({ ok: true, kind: "backlog.list" }) },
    { label: "missing failure error", payload: JSON.stringify({ ok: false, kind: "backlog.list" }) },
    { label: "missing failure message", payload: JSON.stringify({ ok: false, kind: "backlog.list", error: { code: "provider" } }) },
  ])("rejects malformed $label envelopes as BacklogServiceError", async ({ payload }) => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: payload, stderr: "" });
    const service = createBacklogService(deps);
    await expect(service.list("/workspace")).rejects.toMatchObject({ code: "provider" });
  });

  it("falls back to 'unknown' when stdout is empty and stderr carries the failure", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "subprocess crashed" });
    const service = createBacklogService(deps);
    await expect(service.list("/workspace")).rejects.toMatchObject({ code: "unknown", message: expect.stringContaining("subprocess") });
  });

  it("throws BacklogServiceError('auth') when afk CLI is missing on PATH", async () => {
    const { deps } = makeDeps({ resolveAfk: async () => "" });
    const service = createBacklogService(deps);
    await expect(service.list("/workspace")).rejects.toMatchObject({ code: "auth" });
  });

  it("returns 30s-cached items without re-invoking the subprocess", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("1")] }),
      stderr: "",
    });
    const service = createBacklogService(deps);
    const first = await service.list("/workspace");
    const second = await service.list("/workspace");
    expect(first).toBe(second);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("treats different (workspace, options, platform) tuples as separate cache keys", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("1")] }),
      stderr: "",
    });
    const service = createBacklogService(deps);
    await service.list("/workspace-a");
    await service.list("/workspace-b");
    await service.list("/workspace-a", { platform: "github" });
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it("expires cache entries after the configured TTL", async () => {
    vi.useFakeTimers();
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("1")] }),
      stderr: "",
    });
    const service = createBacklogService(deps, { ttlMs: 1000 });
    await service.list("/workspace");
    vi.advanceTimersByTime(1001);
    await service.list("/workspace");
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});

describe("backlog service: write operations invalidate list cache", () => {
  beforeEach(() => vi.useRealTimers());

  it("create invalidates the list cache", async () => {
    const { deps, execMock } = makeDeps();
    execMock
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("1")] }), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.create", data: stubItem("2") }), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("2")] }), stderr: "" });
    const service = createBacklogService(deps);
    const before = await service.list("/workspace");
    const created = await service.create("/workspace", { title: "fresh", description: "desc" });
    const after = await service.list("/workspace");
    expect(created.id).toBe("2");
    expect(before).not.toBe(after);
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it("addTag invalidates the list cache", async () => {
    const { deps, execMock } = makeDeps();
    execMock
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("1", { tags: [] })] }), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.tag.add", data: stubItem("1", { tags: ["urgent"] }) }), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [stubItem("1", { tags: ["urgent"] })] }), stderr: "" });
    const service = createBacklogService(deps);
    await service.list("/workspace");
    const updated = await service.addTag("/workspace", "1", "urgent");
    const list = await service.list("/workspace");
    expect(updated.tags).toContain("urgent");
    expect(list[0].tags).toContain("urgent");
    expect(execMock).toHaveBeenCalledTimes(3);
  });
});

describe("backlog service: timeout", () => {
  it("aborts a hung subprocess after the configured timeout", async () => {
    vi.useFakeTimers();
    const { deps, execMock } = makeDeps();
    let resolveExec: (value: unknown) => void = () => undefined;
    execMock.mockImplementationOnce(() => new Promise(resolve => { resolveExec = resolve; }) as ReturnType<typeof vi.fn>);
    const service = createBacklogService(deps, { timeoutMs: 1000 });
    const inflight = service.list("/workspace");
    const catcher = expect(inflight).rejects.toBeInstanceOf(BacklogServiceError);
    await vi.advanceTimersByTimeAsync(1500);
    await catcher;
    resolveExec({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.list", data: [] }), stderr: "" });
    vi.useRealTimers();
  }, 10_000);
});

describe("backlog service: show / create / addTag / removeTag", () => {
  it("show forwards --id and parses the success envelope", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.show", data: stubItem("42") }), stderr: "" });
    const service = createBacklogService(deps);
    const item = await service.show("/workspace", "42");
    expect(item.id).toBe("42");
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toEqual(["backlog", "show", "--id", "42", "--json"]);
  });

  it("create assembles every supported relationship, mode, tag, and platform flag", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.create", data: stubItem("new") }), stderr: "" });
    const service = createBacklogService(deps);
    const item = await service.create("/workspace", {
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
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toEqual([
      "backlog", "create", "fresh",
      "--description-file", expect.stringMatching(/afk-backlog-.*\/description\.md$/),
      "--parent", "epic-7",
      "--base-backlog", "base-3",
      "--depends-on", "dep-1",
      "--depends-on", "dep-2",
      "--mode", "hitl",
      "--tag", "billing",
      "--tag", "urgent",
      "--platform", "gitlab",
      "--json",
    ]);
  });

  it("addTag forwards --tag and returns the updated item", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.tag.add", data: stubItem("1", { tags: ["x"] }) }), stderr: "" });
    const service = createBacklogService(deps);
    const item = await service.addTag("/workspace", "1", "x");
    expect(item.tags).toEqual(["x"]);
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toEqual(["backlog", "tag", "add", "--id", "1", "--tag", "x", "--json"]);
  });

  it("removeTag forwards --tag and returns the updated item", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.tag.remove", data: stubItem("1", { tags: [] }) }), stderr: "" });
    const service = createBacklogService(deps);
    const item = await service.removeTag("/workspace", "1", "x");
    expect(item.tags).toEqual([]);
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toEqual(["backlog", "tag", "remove", "--id", "1", "--tag", "x", "--json"]);
  });
});
