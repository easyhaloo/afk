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
    const items = await service.list("/workspace", { state: "ready", tag: "billing", platform: "github" });
    expect(items).toEqual([stubItem("1"), stubItem("2")]);
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toContain("--json");
    expect(argv).toContain("--state");
    expect(argv).toContain("ready");
    expect(argv).toContain("--tag");
    expect(argv).toContain("billing");
    expect(argv).toContain("--platform");
    expect(argv).toContain("github");
    expect(argv[argv.length - 1]).toBe("--json");
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
    expect(argv).toContain("show");
    expect(argv).toContain("--id");
    expect(argv).toContain("42");
    expect(argv).toContain("--json");
  });

  it("create forwards title + description and parses the new item", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.create", data: stubItem("new") }), stderr: "" });
    const service = createBacklogService(deps);
    const item = await service.create("/workspace", { title: "fresh", description: "demo", tags: ["billing"] });
    expect(item.id).toBe("new");
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv[argv.length - 1]).toBe("--json");
    expect(argv).toContain("--tag");
    expect(argv).toContain("billing");
  });

  it("addTag forwards --tag and returns the updated item", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.tag.add", data: stubItem("1", { tags: ["x"] }) }), stderr: "" });
    const service = createBacklogService(deps);
    const item = await service.addTag("/workspace", "1", "x");
    expect(item.tags).toEqual(["x"]);
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toContain("tag");
    expect(argv).toContain("add");
    expect(argv).toContain("--tag");
    expect(argv).toContain("x");
  });

  it("removeTag forwards --tag and returns the updated item", async () => {
    const { deps, execMock } = makeDeps();
    execMock.mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.tag.remove", data: stubItem("1", { tags: [] }) }), stderr: "" });
    const service = createBacklogService(deps);
    const item = await service.removeTag("/workspace", "1", "x");
    expect(item.tags).toEqual([]);
    const argv = execMock.mock.calls[0][1] as string[];
    expect(argv).toContain("remove");
  });
});
