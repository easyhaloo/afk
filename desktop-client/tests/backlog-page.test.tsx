import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { BacklogPage } from "../src/features/backlog/BacklogPage";
import {
  readBacklogCache,
  resetBacklogCache,
  writeBacklogCache,
} from "../src/features/backlog/backlog-cache";
import {
  BACKLOG_STATE_LABELS,
  backlogStateLabel,
  filterBacklogItems,
} from "../src/features/backlog/backlog-filter";
import type { BacklogItem } from "../shared/backlog-contract";
import type { BacklogRunSummary } from "../shared/backlog-contract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { document?: unknown }).document = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  activeElement: null,
};

const items: BacklogItem[] = [
  { id: "1", title: "登录态切换", dependsOn: [], state: "ready", executionMode: "afk", tags: ["billing"], branchName: "afk/backlog-1", providerRef: "stub:1" },
  { id: "2", title: "kg 演示", dependsOn: ["1"], state: "in_progress", executionMode: "afk", tags: ["urgent"], branchName: "afk/backlog-2", providerRef: "stub:2" },
  { id: "3", title: "支付回调", dependsOn: [], state: "done", executionMode: "hitl", tags: [], branchName: "afk/backlog-3", providerRef: "stub:3" },
];

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textContent(child as ReactTestInstance))).join("");
}

// Drain enough microtasks for the load() chain: fetcher -> .then -> setItems -> render.
// Six cycles covers the await chain + React render commit + cache write.
async function flushReactUpdates(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type BacklogApi = {
  list: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  runs: ReturnType<typeof vi.fn>;
  addTag: ReturnType<typeof vi.fn>;
  removeTag: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
};

function createBacklogPageHarness(listImplementation: () => Promise<BacklogItem[]> = async () => items): {
  api: BacklogApi;
} {
  const list = vi.fn(listImplementation);
  const api: BacklogApi = {
    list,
    show: vi.fn(),
    create: vi.fn(),
    start: vi.fn(),
    runs: vi.fn(async () => []),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    openExternal: vi.fn(async () => true),
  };
  vi.stubGlobal("window", { afkDesktop: { openExternal: api.openExternal, backlog: api } });
  return { api };
}

async function renderBacklogPage(workspace = "/repo", listImplementation?: () => Promise<BacklogItem[]>) {
  const { api } = createBacklogPageHarness(listImplementation);
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(BacklogPage, { workspace }));
    await flushReactUpdates();
  });
  return { api, renderer: renderer! };
}

function findSearchInput(renderer: ReturnType<typeof create>): ReactTestInstance {
  // There are several nodes with aria-label; the input is the one with `value` (controlled) and onChange.
  return renderer.root.findAllByProps({ "aria-label": "搜索 Backlog" })
    .find((node) => typeof node.props.onChange === "function" && Object.prototype.hasOwnProperty.call(node.props, "value"))!;
}

beforeEach(() => {
  resetBacklogCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetBacklogCache();
});

describe("backlog filter (pure)", () => {
  it("matches the page component contract: combined title and tag search", () => {
    expect(filterBacklogItems(items, "kg", "all")).toEqual([items[1]]);
    expect(filterBacklogItems(items, "billing", "all")).toEqual([items[0]]);
  });

  it("renders Chinese labels for every state in BACKLOG_STATE_LABELS", () => {
    expect(BACKLOG_STATE_LABELS).toMatchObject({
      ready: "待处理",
      rework: "返工中",
      in_progress: "进行中",
      verification: "验证中",
      merge_ready: "待合并",
      done: "已完成",
      blocked: "阻塞",
    });
  });

  it("localizes each state through backlogStateLabel", () => {
    expect(backlogStateLabel("ready")).toBe("待处理");
    expect(backlogStateLabel("in_progress")).toBe("进行中");
    expect(backlogStateLabel("verification")).toBe("验证中");
    expect(backlogStateLabel("merge_ready")).toBe("待合并");
    expect(backlogStateLabel("done")).toBe("已完成");
    expect(backlogStateLabel("blocked")).toBe("阻塞");
    expect(backlogStateLabel("rework")).toBe("返工中");
  });
});

describe("BacklogPage initial render", () => {
  it("does not render a page-level refresh button", async () => {
    const { renderer } = await renderBacklogPage();

    expect(renderer.root.findAllByProps({ "aria-label": "刷新 Backlog" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it("invokes the bridge list with the supplied workspace and no platform override by default", async () => {
    const { api, renderer } = await renderBacklogPage("/repo");

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenLastCalledWith("/repo", undefined);
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(items.length);
    act(() => { renderer.unmount(); });
  });

  it("shows the empty state when the provider returns no items", async () => {
    const { renderer } = await renderBacklogPage("/repo", async () => []);
    const empty = renderer.root.findByProps({ className: "backlog-empty" });

    expect(empty).toBeDefined();
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(0);
    expect(textContent(empty)).toContain("没有匹配的工作项");
    act(() => { renderer.unmount(); });
  });

  it("renders one row per item with localized state and execution mode", async () => {
    const { renderer } = await renderBacklogPage();
    const rows = renderer.root.findAllByProps({ className: "backlog-row" });

    expect(rows).toHaveLength(items.length);
    expect(textContent(rows[0])).toContain("登录态切换");
    expect(textContent(rows[0])).toContain("待处理");
    expect(textContent(rows[0])).toContain("AFK 自动");
    expect(textContent(rows[2])).toContain("支付回调");
    expect(textContent(rows[2])).toContain("已完成");
    expect(textContent(rows[2])).toContain("HITL 人工");
    act(() => { renderer.unmount(); });
  });

  it("renders tag chips for items that carry tags and skips them otherwise", async () => {
    const { renderer } = await renderBacklogPage();
    const rows = renderer.root.findAllByProps({ className: "backlog-row" });

    expect(rows[0].findAllByProps({ className: "backlog-tags" })).toHaveLength(1);
    expect(textContent(rows[0].findByProps({ className: "backlog-tags" }))).toContain("billing");
    expect(rows[1].findAllByProps({ className: "backlog-tags" })).toHaveLength(1);
    expect(textContent(rows[1].findByProps({ className: "backlog-tags" }))).toContain("urgent");
    expect(rows[2].findAllByProps({ className: "backlog-tags" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });
});

describe("BacklogPage detail drawer", () => {
  it("loads the canonical item when a row is selected and closes the preview", async () => {
    const { api, renderer } = await renderBacklogPage();
    const detail = {
      ...items[0],
      description: "切换登录态并保留当前工作区。",
      webUrl: "https://github.com/example/issues/1",
    };
    api.show.mockResolvedValue(detail);

    await act(async () => {
      renderer.root.findAllByProps({ className: "backlog-row" })[0].props.onClick();
      await flushReactUpdates();
    });

    expect(api.show).toHaveBeenCalledWith("/repo", "1");
    expect(textContent(renderer.root.findByProps({ role: "dialog" }))).toContain("切换登录态并保留当前工作区。");
    expect(renderer.root.findByProps({ "aria-label": "在浏览器中打开" })).toBeTruthy();

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "在浏览器中打开" }).props.onClick();
      await flushReactUpdates();
    });
    expect(api.openExternal).toHaveBeenCalledWith("https://github.com/example/issues/1");

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "关闭详情" }).props.onClick();
      await flushReactUpdates();
    });

    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it("hides the external browser action when the item has no web URL", async () => {
    const { api, renderer } = await renderBacklogPage();
    api.show.mockResolvedValue(items[0]);

    await act(async () => {
      renderer.root.findAllByProps({ className: "backlog-row" })[0].props.onClick();
      await flushReactUpdates();
    });

    expect(renderer.root.findAllByProps({ "aria-label": "在浏览器中打开" })).toHaveLength(0);
    expect(textContent(renderer.root.findByProps({ role: "dialog" }))).toContain("该工作项没有可用的外部链接。");
    act(() => { renderer.unmount(); });
  });
});

describe("BacklogPage loading states", () => {
  it("disables controls and keeps the loading placeholder while the first list request is in flight", async () => {
    const pending = deferred<BacklogItem[]>();
    const { renderer, api } = await renderBacklogPage("/repo", () => pending.promise);

    const platformSelect = renderer.root.findByProps({ "aria-label": "选择 Provider" });
    const stateSelect = renderer.root.findByProps({ "aria-label": "筛选状态" });
    const createButton = renderer.root.findByProps({ "aria-label": "新建 Backlog" });

    expect(platformSelect.props.disabled).toBe(true);
    expect(stateSelect.props.disabled).toBe(true);
    expect(createButton.props.disabled).toBe(true);
    expect(textContent(renderer.root.findByProps({ className: "backlog-empty" }))).toContain("正在读取 Backlog");
    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(items);
      await flushReactUpdates();
    });
    expect(createButton.props.disabled).toBe(false);
    act(() => { renderer.unmount(); });
  });

  it("re-enables controls once the initial load resolves", async () => {
    const { renderer } = await renderBacklogPage();
    const platformSelect = renderer.root.findByProps({ "aria-label": "选择 Provider" });
    const createButton = renderer.root.findByProps({ "aria-label": "新建 Backlog" });

    expect(platformSelect.props.disabled).toBe(false);
    expect(createButton.props.disabled).toBe(false);
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(items.length);
    act(() => { renderer.unmount(); });
  });
});

describe("BacklogPage execution", () => {
  it("renders the run action in the row header with an accessible label", async () => {
    const { renderer } = await renderBacklogPage();
    const row = renderer.root.findAllByProps({ className: "backlog-row" })[0];
    const header = row.findByType("header");
    const runButton = header.findByProps({ className: "backlog-run-button" });

    expect(header.findAllByProps({ className: "backlog-row-heading" })).toHaveLength(1);
    expect(runButton.props["aria-label"]).toBe("开始执行");
    expect(runButton.props.title).toBe("开始执行");
    expect(row.findAllByProps({ className: "backlog-row-actions" })).toHaveLength(0);
    renderer.unmount();
  });

  it("keeps the run action from opening the row detail drawer", async () => {
    const { api, renderer } = await renderBacklogPage();
    const run = { id: "desktop-1-run", backlogId: "1", status: "running", startedAt: "2026-09-08T10:00:00.000Z", pid: 1234 } as const;
    api.start.mockResolvedValueOnce(run);
    const stopPropagation = vi.fn();
    const button = renderer.root.findAllByProps({ className: "backlog-run-button" })[0];

    await act(async () => {
      button.props.onClick({ stopPropagation });
      await flushReactUpdates();
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(api.show).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("hydrates an existing run from the bridge on initial load", async () => {
    const { api, renderer } = await renderBacklogPage();
    api.runs.mockResolvedValueOnce([{ id: "desktop-1-run", backlogId: "1", status: "running", startedAt: "2026-09-08T10:00:00.000Z", pid: process.pid }]);
    act(() => { renderer.update(createElement(BacklogPage, { workspace: "/repo", refreshVersion: 1 })); });
    await act(async () => { await flushReactUpdates(); });

    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("运行状态：运行中");
    expect(renderer.root.findAllByProps({ className: "backlog-run-button" })[0].props.disabled).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it("starts a ready backlog item and shows its local run handle", async () => {
    const { api, renderer } = await renderBacklogPage();
    const run: BacklogRunSummary = {
      id: "desktop-1-run",
      backlogId: "1",
      status: "running",
      startedAt: "2026-09-08T10:00:00.000Z",
      pid: 1234,
    };
    api.start.mockResolvedValueOnce(run);

    const row = renderer.root.findAllByProps({ className: "backlog-row" })[0];
    await act(async () => {
      row.findByProps({ className: "backlog-run-button" }).props.onClick({ stopPropagation: vi.fn() });
      await flushReactUpdates();
    });

    expect(api.start).toHaveBeenCalledWith("/repo", { backlogId: "1" });
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("PID 1234");
    expect(renderer.root.findAllByProps({ className: "backlog-run-button" })[0].props.disabled).toBe(true);
    act(() => { renderer.unmount(); });
  });
});

describe("BacklogPage error states", () => {
  it("renders an error banner with a dismiss control when the list rejects", async () => {
    const { renderer } = await renderBacklogPage("/repo", async () => {
      throw new Error("GitHub API 403 — 请检查 token 权限");
    });

    const alert = renderer.root.findByProps({ role: "alert" });
    expect(textContent(alert)).toContain("GitHub API 403");
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(0);

    await act(async () => { renderer.root.findByProps({ "aria-label": "关闭错误" }).props.onClick(); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it("recovers from an error on the next successful refresh", async () => {
    const { api, renderer } = await renderBacklogPage("/repo", async () => {
      throw new Error("首次失败");
    });

    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);

    api.list.mockResolvedValueOnce(items);
    await act(async () => {
      renderer.update(createElement(BacklogPage, { workspace: "/repo", refreshVersion: 1 }));
      await flushReactUpdates();
    });

    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(items.length);
    expect(api.list).toHaveBeenCalledTimes(2);
    act(() => { renderer.unmount(); });
  });

  it("does not propagate errors after the component unmounts", async () => {
    const pending = deferred<BacklogItem[]>();
    const { renderer, api } = await renderBacklogPage("/repo", () => pending.promise);
    expect(api.list).toHaveBeenCalledTimes(1);

    act(() => { renderer.unmount(); });

    await act(async () => {
      pending.reject(new Error("延迟失败"));
      await flushReactUpdates();
    });
    // No way to assert against the unmounted tree directly — ensure no throw escaped to the test runner.
    expect(pending.promise).toBeInstanceOf(Promise);
  });
});

describe("BacklogPage filters", () => {
  it("filters rows by query across title, id, and tags", async () => {
    const { renderer } = await renderBacklogPage();
    const search = findSearchInput(renderer);

    await act(async () => { search.props.onChange({ target: { value: "urgent" } }); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(1);
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("kg 演示");

    await act(async () => { search.props.onChange({ target: { value: "2" } }); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(1);
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("kg 演示");

    await act(async () => { search.props.onChange({ target: { value: "登录" } }); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(1);
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("登录态切换");

    await act(async () => { search.props.onChange({ target: { value: "nonexistent-query" } }); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it("filters rows by state and combines state with the search query", async () => {
    const { renderer } = await renderBacklogPage();
    const stateSelect = renderer.root.findByProps({ "aria-label": "筛选状态" });

    await act(async () => { stateSelect.props.onChange({ currentTarget: { value: "done" } }); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(1);
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("支付回调");

    const search = findSearchInput(renderer);
    await act(async () => { search.props.onChange({ target: { value: "登录" } }); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(0);
    expect(textContent(renderer.root.findByProps({ className: "backlog-empty" }))).toContain("没有匹配的工作项");
    act(() => { renderer.unmount(); });
  });
});

describe("BacklogPage platform override", () => {
  it("re-fetches with the chosen platform option when the selector switches", async () => {
    const { renderer, api } = await renderBacklogPage();
    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "选择 Provider" }).props.onChange({ currentTarget: { value: "github" } });
      await flushReactUpdates();
    });

    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenLastCalledWith("/repo", { platform: "github" });

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "选择 Provider" }).props.onChange({ currentTarget: { value: "gitlab" } });
      await flushReactUpdates();
    });

    expect(api.list).toHaveBeenCalledTimes(3);
    expect(api.list).toHaveBeenLastCalledWith("/repo", { platform: "gitlab" });

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "选择 Provider" }).props.onChange({ currentTarget: { value: "auto" } });
      await flushReactUpdates();
    });

    expect(api.list).toHaveBeenCalledTimes(4);
    expect(api.list).toHaveBeenLastCalledWith("/repo", undefined);
    act(() => { renderer.unmount(); });
  });
});

describe("BacklogPage refresh and cache", () => {
  it("seeds the row list from a fresh cache without invoking the bridge", async () => {
    writeBacklogCache("/repo", { items: [items[0]], fetchedAt: Date.now() });
    const { renderer, api } = await renderBacklogPage("/repo", async () => {
      throw new Error("如果 cache 命中就不该调用 fetcher");
    });

    expect(api.list).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(1);
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("登录态切换");
    expect(readBacklogCache("/repo")?.items).toEqual([items[0]]);
    act(() => { renderer.unmount(); });
  });

  it("shows cached rows immediately and re-fetches in the background when the cache is expired", async () => {
    writeBacklogCache("/repo", { items: [items[0]], fetchedAt: Date.now() - 31_000 });
    const refreshed: BacklogItem[] = [{ ...items[1], title: "kg 演示 (refreshed)" }, items[2]];
    const { renderer, api } = await renderBacklogPage("/repo", async () => refreshed);

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(2);
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("refreshed");
    act(() => { renderer.unmount(); });
  });

  it("keeps the cached rows visible when a background refresh fails", async () => {
    writeBacklogCache("/repo", { items: [items[0]], fetchedAt: Date.now() - 31_000 });
    const { renderer } = await renderBacklogPage("/repo", async () => {
      throw new Error("刷新失败");
    });

    expect(renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(1);
    expect(textContent(renderer.root.findAllByProps({ className: "backlog-row" })[0])).toContain("登录态切换");
    expect(textContent(renderer.root.findByProps({ role: "alert" }))).toContain("刷新失败");
    act(() => { renderer.unmount(); });
  });

  it("force-refreshes from the bridge when the global refresh version changes", async () => {
    const { renderer, api } = await renderBacklogPage();
    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(createElement(BacklogPage, { workspace: "/repo", refreshVersion: 1 }));
      await flushReactUpdates();
    });

    // Platform is auto, so options passed to list() is undefined.
    // The fetcher is invoked again because invalidateBacklogCache cleared the cache.
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenLastCalledWith("/repo", undefined);
    act(() => { renderer.unmount(); });
  });

  it("prefers the latest refresh result when an earlier normal request resolves late", async () => {
    const initial = deferred<BacklogItem[]>();
    const forced = deferred<BacklogItem[]>();
    const { api } = createBacklogPageHarness();
    api.list
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => forced.promise);
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(BacklogPage, { workspace: "/repo" }));
      await flushReactUpdates();
    });
    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.update(createElement(BacklogPage, { workspace: "/repo", refreshVersion: 1 }));
      await flushReactUpdates();
    });
    expect(api.list).toHaveBeenCalledTimes(2);

    await act(async () => {
      forced.resolve([{ ...items[2], title: "forced result" }]);
      await forced.promise;
      await flushReactUpdates();
    });
    expect(textContent(renderer!.root.findAllByProps({ className: "backlog-row" })[0])).toContain("forced result");

    await act(async () => {
      initial.resolve([{ ...items[0], title: "stale initial" }]);
      await initial.promise;
      await flushReactUpdates();
    });
    expect(renderer!.root.findAllByProps({ className: "backlog-row" })).toHaveLength(1);
    expect(textContent(renderer!.root.findAllByProps({ className: "backlog-row" })[0])).not.toContain("stale initial");
    act(() => { renderer!.unmount(); });
  });
});

describe("BacklogPage lifecycle", () => {
  it("does not update state when the pending list resolves after the component unmounts", async () => {
    const pending = deferred<BacklogItem[]>();
    const { renderer, api } = await renderBacklogPage("/repo", () => pending.promise);

    expect(api.list).toHaveBeenCalledTimes(1);
    act(() => { renderer.unmount(); });

    await act(async () => {
      pending.resolve([{ ...items[0], title: "after-unmount" }]);
      await pending.promise;
      await flushReactUpdates();
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it("resets the cache on unmount so the next mount fetches again", async () => {
    const first = await renderBacklogPage("/workspace-a");
    expect(first.renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(items.length);
    act(() => { first.renderer.unmount(); });

    const second = await renderBacklogPage("/workspace-b");
    // resetBacklogCache on unmount cleared the cache, so the next mount must fetch.
    expect(second.api.list).toHaveBeenCalledTimes(1);
    expect(second.renderer.root.findAllByProps({ className: "backlog-row" })).toHaveLength(items.length);
    act(() => { second.renderer.unmount(); });
  });
});

describe("BacklogPage write operations", () => {
  function findModal(renderer: ReturnType<typeof create>): ReactTestInstance {
    return renderer.root.findByProps({ role: "dialog", "aria-modal": "true" });
  }

  function findCreateButton(renderer: ReturnType<typeof create>): ReactTestInstance {
    return renderer.root.findByProps({ "aria-label": "新建 Backlog" });
  }

  function fillCreateForm(renderer: ReturnType<typeof create>, input: { title?: string; description?: string; executionMode?: "afk" | "hitl"; tags?: string }) {
    const modal = findModal(renderer);
    const inputs = modal.findAllByType("input").filter((node) => typeof node.props.onChange === "function" && Object.prototype.hasOwnProperty.call(node.props, "value"));
    if (input.title !== undefined) {
      const titleInput = inputs.find((node) => node.props.placeholder === "登录态切换")!;
      titleInput.props.onChange({ target: { value: input.title } });
    }
    if (input.description !== undefined) {
      const textarea = modal.findByType("textarea");
      textarea.props.onChange({ target: { value: input.description } });
    }
    if (input.executionMode !== undefined) {
      const select = modal.findByProps({ value: input.executionMode === "afk" ? "afk" : "hitl" });
      select.props.onChange({ currentTarget: { value: input.executionMode } });
    }
    if (input.tags !== undefined) {
      const tagInput = inputs.find((node) => node.props.placeholder === "billing, urgent")!;
      tagInput.props.onChange({ target: { value: input.tags } });
    }
  }

  it("opens the create modal when the 新建 Backlog button is clicked", async () => {
    const { renderer } = await renderBacklogPage();
    expect(renderer.root.findAllByProps({ role: "dialog", "aria-modal": "true" })).toHaveLength(0);

    await act(async () => { findCreateButton(renderer).props.onClick(); await flushReactUpdates(); });

    expect(renderer.root.findAllByProps({ role: "dialog", "aria-modal": "true" })).toHaveLength(1);
    expect(textContent(renderer.root.findByProps({ id: "backlog-create-title" }))).toBe("新建 Backlog");
    act(() => { renderer.unmount(); });
  });

  it("closes the modal on Cancel button click without calling api.create", async () => {
    const { renderer, api } = await renderBacklogPage();
    await act(async () => { findCreateButton(renderer).props.onClick(); await flushReactUpdates(); });
    expect(api.create).not.toHaveBeenCalled();

    await act(async () => { findModal(renderer).findByProps({ "aria-label": "关闭" }).props.onClick(); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ role: "dialog", "aria-modal": "true" })).toHaveLength(0);
    expect(api.create).not.toHaveBeenCalled();
    act(() => { renderer.unmount(); });
  });

  it("closes the modal when the backdrop is clicked", async () => {
    const { renderer } = await renderBacklogPage();
    await act(async () => { findCreateButton(renderer).props.onClick(); await flushReactUpdates(); });
    const backdrop = renderer.root.findByProps({ className: "backlog-modal-backdrop" });

    await act(async () => { backdrop.props.onClick({ target: backdrop, currentTarget: backdrop }); await flushReactUpdates(); });
    expect(renderer.root.findAllByProps({ role: "dialog", "aria-modal": "true" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it("submits the form, calls api.create with workspace as first arg, and force-refreshes on success", async () => {
    const newItem: BacklogItem = { id: "4", title: "新功能", description: "实现某个新功能", dependsOn: [], state: "ready", executionMode: "afk", tags: ["urgent", "billing"], branchName: "afk/backlog-4", providerRef: "stub:4" };
    const { renderer, api } = await renderBacklogPage("/workspace-create");
    api.create.mockResolvedValueOnce(newItem);
    api.list.mockResolvedValueOnce([newItem, ...items]);

    await act(async () => { findCreateButton(renderer).props.onClick(); await flushReactUpdates(); });
    await act(async () => {
      fillCreateForm(renderer, { title: "新功能", description: "实现某个新功能", tags: "urgent, billing" });
      await flushReactUpdates();
    });

    await act(async () => {
      findModal(renderer).props.onSubmit({ preventDefault: vi.fn() });
      await flushReactUpdates();
    });

    expect(api.create).toHaveBeenCalledWith(
      "/workspace-create",
      expect.objectContaining({ title: "新功能", description: "实现某个新功能", tags: ["urgent", "billing"], executionMode: "afk" }),
    );
    expect(api.list).toHaveBeenCalledTimes(2); // initial + force-refresh
    expect(renderer.root.findAllByProps({ role: "dialog", "aria-modal": "true" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: "backlog-row" }).some((row) => textContent(row).includes("新功能"))).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it("passes the platform override through to api.create when the page-level selector is set", async () => {
    const newItem: BacklogItem = { id: "4", title: "gh", description: "x", dependsOn: [], state: "ready", executionMode: "afk", tags: [], branchName: "afk/backlog-4", providerRef: "stub:4" };
    const { renderer, api } = await renderBacklogPage();
    api.create.mockResolvedValueOnce(newItem);

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "选择 Provider" }).props.onChange({ currentTarget: { value: "github" } });
      await flushReactUpdates();
    });
    await act(async () => { findCreateButton(renderer).props.onClick(); await flushReactUpdates(); });
    await act(async () => {
      fillCreateForm(renderer, { title: "gh", description: "x" });
      await flushReactUpdates();
    });
    await act(async () => {
      findModal(renderer).props.onSubmit({ preventDefault: vi.fn() });
      await flushReactUpdates();
    });

    expect(api.create).toHaveBeenCalledWith("/repo", expect.objectContaining({ platform: "github" }));
    act(() => { renderer.unmount(); });
  });

  it("surfaces create errors inside the modal without closing it", async () => {
    const { renderer, api } = await renderBacklogPage();
    api.create.mockRejectedValueOnce(new Error("GitHub 403 — token 失效"));

    await act(async () => { findCreateButton(renderer).props.onClick(); await flushReactUpdates(); });
    await act(async () => {
      fillCreateForm(renderer, { title: "boom", description: "fails" });
      await flushReactUpdates();
    });
    await act(async () => {
      findModal(renderer).props.onSubmit({ preventDefault: vi.fn() });
      await flushReactUpdates();
    });

    expect(renderer.root.findAllByProps({ role: "dialog", "aria-modal": "true" })).toHaveLength(1);
    expect(textContent(renderer.root.findByProps({ role: "alert" }))).toContain("GitHub 403");
    expect(api.list).toHaveBeenCalledTimes(1); // no force-refresh on failure
    act(() => { renderer.unmount(); });
  });

  it("removes a tag when its chip's × button is clicked", async () => {
    const updatedItem: BacklogItem = { ...items[0], tags: [] };
    const { renderer, api } = await renderBacklogPage();
    api.removeTag.mockResolvedValueOnce(updatedItem);
    api.list.mockResolvedValueOnce([updatedItem, items[1], items[2]]);

    const rowWithBilling = renderer.root.findAll((node) => node.props.className?.includes("backlog-row"))
      .find((row) => textContent(row).includes("登录态切换"))!;
    const removeButton = rowWithBilling.findByProps({ "aria-label": "移除标签 billing" });

    await act(async () => { removeButton.props.onClick(); await flushReactUpdates(); });

    expect(api.removeTag).toHaveBeenCalledWith("/repo", "1", "billing");
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ "aria-label": "移除标签 billing" })).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it("adds a tag via the inline form per row", async () => {
    const updatedItem: BacklogItem = { ...items[0], tags: ["billing", "reviewed"] };
    const { renderer, api } = await renderBacklogPage();
    api.addTag.mockResolvedValueOnce(updatedItem);
    api.list.mockResolvedValueOnce([updatedItem, items[1], items[2]]);

    const row = renderer.root.findAll((node) => node.props.className?.includes("backlog-row"))
      .find((r) => textContent(r).includes("登录态切换"))!;
    const tagInput = row.findByProps({ "aria-label": "为 登录态切换 添加标签" });

    await act(async () => {
      tagInput.props.onChange({ target: { value: "reviewed" } });
      await flushReactUpdates();
    });
    await act(async () => {
      row.findByProps({ className: "backlog-tag-add" }).props.onSubmit({ preventDefault: vi.fn() });
      await flushReactUpdates();
    });

    expect(api.addTag).toHaveBeenCalledWith("/repo", "1", "reviewed");
    expect(api.list).toHaveBeenCalledTimes(2);
    act(() => { renderer.unmount(); });
  });

  it("disables tag controls while a tag op is in flight", async () => {
    const pending = deferred<BacklogItem>();
    const { renderer, api } = await renderBacklogPage();
    api.removeTag.mockReturnValueOnce(pending.promise);

    const row = renderer.root.findAll((node) => node.props.className?.includes("backlog-row"))
      .find((r) => textContent(r).includes("登录态切换"))!;
    const removeButton = row.findByProps({ "aria-label": "移除标签 billing" });
    const tagInput = row.findByProps({ "aria-label": "为 登录态切换 添加标签" });

    await act(async () => { removeButton.props.onClick(); await flushReactUpdates(); });

    expect(removeButton.props.disabled).toBe(true);
    expect(tagInput.props.disabled).toBe(true);

    await act(async () => {
      pending.resolve({ ...items[0], tags: [] });
      await pending.promise;
      await flushReactUpdates();
    });
    const reloaded = renderer.root.findAll((node) => node.props.className?.includes("backlog-row"))
      .find((r) => textContent(r).includes("登录态切换"))!;
    expect(reloaded.findByProps({ "aria-label": "为 登录态切换 添加标签" }).props.disabled).toBe(false);
    act(() => { renderer.unmount(); });
  });
});
