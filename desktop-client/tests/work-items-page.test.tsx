import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkItemsPage } from "../src/features/work-items/WorkItemsPage";
import type { WorkItemInventoryResult } from "../shared/backlog-contract";
import githubIcon from "../src/assets/provider-icons/github.svg";
import gitlabIcon from "../src/assets/provider-icons/gitlab.svg";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textContent(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === "string" ? child : textContent(child as ReactTestInstance)).join("");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function selectProvider(renderer: ReturnType<typeof create>, name: string) {
  renderer.root.findByProps({ "aria-label": "选择 Provider" }).props.onChange({ currentTarget: { value: name } });
}

function findButton(renderer: ReturnType<typeof create>, label: string): ReactTestInstance {
  const button = renderer.root.findAllByType("button").find(node => textContent(node).includes(label));
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
}

const result: WorkItemInventoryResult = {
  items: [
    { id: "github:acme/api#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/api", name: "api" }, title: "API issue", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "afk/backlog-1", providerRef: "github:acme/api#1" },
    { id: "github:acme/web#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/web", name: "web" }, title: "Web issue", managed: false, executionEligible: false, state: "ready", executionMode: "hitl", dependsOn: [], tags: [], branchName: "afk/backlog-1", providerRef: "github:acme/web#1" },
  ],
  projects: [
    { platform: "github", projectKey: "acme/api", name: "api" },
    { platform: "github", projectKey: "acme/web", name: "web" },
  ],
  diagnostics: [],
  complete: true,
};

const multiResourceResult: WorkItemInventoryResult = {
  items: [
    {
      id: "WI-2026-018",
      issueNumber: 184,
      project: { platform: "github", projectKey: "acme/checkout-service", name: "checkout-service", defaultBranch: "main" },
      title: "支付链路重构与灰度切换",
      description: "统一新旧支付协议，由服务端、控制台和部署配置三个仓库协同完成。",
      managed: true,
      executionEligible: true,
      state: "ready",
      executionMode: "afk",
      dependsOn: [],
      tags: ["payments", "multi-repo"],
      branchName: "afk/WI-2026-018",
      providerRef: "work-item:WI-2026-018",
      sources: [
        {
          id: "github:acme/checkout-service#184",
          type: "github_issue",
          title: "支付 API 兼容改造",
          reference: "acme/checkout-service#184",
          role: "主要需求",
          platform: "github",
          projectKey: "acme/checkout-service",
          issueNumber: 184,
          webUrl: "https://github.com/acme/checkout-service/issues/184",
        },
        {
          id: "gitlab:gitlab.example.com/acme/merchant-console#52",
          type: "gitlab_issue",
          title: "控制台灰度开关",
          reference: "acme/merchant-console#52",
          role: "协作需求",
          platform: "gitlab",
          projectKey: "acme/merchant-console",
          issueNumber: 52,
          webUrl: "https://gitlab.example.com/acme/merchant-console/-/issues/52",
        },
      ],
      repositories: [
        { id: "repo-checkout", platform: "github", projectKey: "acme/checkout-service", name: "checkout-service", defaultBranch: "main", role: "主要仓库", checkoutPath: "repositories/checkout-service" },
        { id: "repo-console", platform: "gitlab", projectKey: "acme/merchant-console", name: "merchant-console", defaultBranch: "develop", role: "协作仓库", checkoutPath: "repositories/merchant-console" },
        { id: "repo-config", platform: "gitlab", projectKey: "acme/deployment-config", name: "deployment-config", role: "配置仓库", checkoutPath: "repositories/deployment-config" },
      ],
      executionPlan: [
        { id: "analyze", title: "分析跨仓库影响范围", detail: "读取两个外部 Issue 和三个关联仓库", status: "pending" },
      ],
      priority: "P1",
      updatedAt: "2026-09-20T08:00:00.000Z",
    },
  ],
  projects: [
    { platform: "github", projectKey: "acme/checkout-service", name: "checkout-service", defaultBranch: "main" },
    { platform: "gitlab", projectKey: "acme/merchant-console", name: "merchant-console", defaultBranch: "develop" },
    { platform: "gitlab", projectKey: "acme/deployment-config", name: "deployment-config", defaultBranch: "main" },
  ],
  diagnostics: [],
  complete: true,
};

describe("WorkItemsPage", () => {
  it("loads globally without a workspace and keeps same-number issues distinct", async () => {
    const list = vi.fn(async () => result);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledWith(undefined);
    const rows = renderer!.root.findAllByProps({ className: "backlog-row work-item-row" });
    expect(rows).toHaveLength(2);
    expect(textContent(rows[0])).toContain("acme/api");
    expect(textContent(rows[1])).toContain("acme/web");
    expect(textContent(rows[0])).toContain("#1");
    expect(textContent(rows[1])).toContain("#1");
    act(() => renderer!.unmount());
  });

  it("renders multiple external sources and repositories on one independent work item", async () => {
    const list = vi.fn(async () => multiResourceResult);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledWith(undefined);
    await act(async () => {
      renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick();
    });

    const detail = renderer!.root.findByProps({ "aria-label": "工作项 WI-2026-018" });
    const detailText = textContent(detail);
    expect(detailText).toContain("支付 API 兼容改造");
    expect(detailText).toContain("控制台灰度开关");
    expect(detailText).toContain("checkout-service");
    expect(detailText).toContain("merchant-console");
    expect(detailText).toContain("deployment-config");
    act(() => renderer!.unmount());
  });

  it("shows an explicitly repository-free work item but disables run creation", async () => {
    const repositoryFreeResult: WorkItemInventoryResult = {
      ...multiResourceResult,
      items: [{ ...multiResourceResult.items[0], id: "WI-2026-019", title: "发布流程权限审计", repositories: [] }],
    };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => repositoryFreeResult) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });

    const executionDialog = renderer!.root.findAllByProps({ role: "dialog" }).find(node => textContent(node).includes("开始执行工作项"));
    expect(executionDialog).toBeDefined();
    expect(textContent(executionDialog!)).toContain("本工作项没有可用于运行的代码仓库");
    expect(findButton(renderer!, "创建运行").props.disabled).toBe(true);
    act(() => renderer!.unmount());
  });

  it("selects every repository with its default base branch when the dialog opens", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => multiResourceResult) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });

    expect(renderer!.root.findByProps({ "aria-label": "选择仓库：checkout-service" }).props.checked).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "选择仓库：merchant-console" }).props.checked).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "选择仓库：deployment-config" }).props.checked).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "Base 分支：checkout-service" }).props.value).toBe("main");
    expect(renderer!.root.findByProps({ "aria-label": "Base 分支：merchant-console" }).props.value).toBe("develop");
    expect(renderer!.root.findByProps({ "aria-label": "Base 分支：deployment-config" }).props.value).toBe("main");
    act(() => renderer!.unmount());
  });

  it("submits selected repositories in display order with independent branches and safe checkout paths", async () => {
    const repositories = [
      { id: "repo-api", platform: "github" as const, projectKey: "acme/api", providerProjectId: "101", name: "api", defaultBranch: "main", role: "主要仓库", checkoutPath: "repositories/custom-api" },
      { id: "repo-shared-a", platform: "gitlab" as const, projectKey: "git.corp/acme/shared-a", providerHost: "git.corp", name: "shared repo", defaultBranch: "develop", role: "协作仓库" },
      { id: "repo-shared-b", platform: "gitlab" as const, projectKey: "acme/shared-b", name: "shared/repo", role: "配置仓库" },
    ];
    const inventory: WorkItemInventoryResult = {
      ...multiResourceResult,
      items: [{ ...multiResourceResult.items[0], repositories }],
    };
    const start = vi.fn(async () => ({ runId: "run-42", workspace: { root: "/tmp/WI-2026-018" } }));
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => inventory), start }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    const executionDialog = renderer!.root.findByProps({ "aria-label": "开始执行工作项" });
    expect(textContent(executionDialog)).toContain("repositories/shared-repo");
    expect(textContent(executionDialog)).toContain("repositories/shared-repo-2");
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Base 分支：api" }).props.onChange({ target: { value: "release/api" } }); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Base 分支：shared repo" }).props.onChange({ target: { value: "feature/shared" } }); });
    await act(async () => { findButton(renderer!, "创建运行").props.onClick(); });

    expect(start).toHaveBeenCalledWith({
      workItemId: "WI-2026-018",
      environment: "local",
      repositories: [
        { platform: "github", projectKey: "acme/api", providerProjectId: "101", name: "api", checkoutPath: "repositories/custom-api", baseBranch: "release/api", role: "主要仓库" },
        { platform: "gitlab", projectKey: "git.corp/acme/shared-a", providerHost: "git.corp", name: "shared repo", checkoutPath: "repositories/shared-repo", baseBranch: "feature/shared", role: "协作仓库" },
        { platform: "gitlab", projectKey: "acme/shared-b", name: "shared/repo", checkoutPath: "repositories/shared-repo-2", baseBranch: "main", role: "配置仓库" },
      ],
    });
    expect(textContent(renderer!.root.findByProps({ "aria-label": "工作项 WI-2026-018" }))).toContain("运行已创建：/tmp/WI-2026-018");
    expect(textContent(renderer!.root.findByProps({ "aria-label": "工作项 WI-2026-018" }))).not.toContain("任务空间已准备");
    act(() => renderer!.unmount());
  });

  it("opens with an invalid default branch as editable inline validation", async () => {
    const inventory: WorkItemInventoryResult = {
      ...multiResourceResult,
      items: [{
        ...multiResourceResult.items[0],
        repositories: [{ id: "repo-invalid", platform: "github", projectKey: "acme/invalid", name: "invalid", defaultBranch: "bad branch" }],
      }],
    };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => inventory), start: vi.fn() }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });

    const input = renderer!.root.findByProps({ "aria-label": "Base 分支：invalid" });
    expect(input.props.value).toBe("bad branch");
    expect(input.props["aria-invalid"]).toBe(true);
    expect(findButton(renderer!, "创建运行").props.disabled).toBe(true);
    act(() => renderer!.unmount());
  });

  it("ignores a stale run success after switching to another work item", async () => {
    const firstRun = deferred<{ runId: string; workspace: { root: string } }>();
    const second = {
      ...multiResourceResult.items[0],
      id: "WI-2026-020",
      title: "第二个工作项",
      repositories: [{ id: "repo-second", platform: "github" as const, projectKey: "acme/second", name: "second", defaultBranch: "trunk" }],
    };
    const inventory = { ...multiResourceResult, items: [multiResourceResult.items[0], second] };
    const start = vi.fn(() => firstRun.promise);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => inventory), start }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { findButton(renderer!, "创建运行").props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "关闭执行配置" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "关闭工作项详情" }).props.onClick(); });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[1].props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { firstRun.resolve({ runId: "run-old", workspace: { root: "/tmp/old" } }); });

    expect(renderer!.root.findByProps({ "aria-label": "开始执行工作项" })).toBeTruthy();
    expect(renderer!.root.findByProps({ "aria-label": "Base 分支：second" })).toBeTruthy();
    expect(textContent(renderer!.root.findByProps({ "aria-label": "工作项 WI-2026-020" }))).not.toContain("/tmp/old");
    act(() => renderer!.unmount());
  });

  it("ignores a stale run error after switching to another work item", async () => {
    const firstRun = deferred<{ runId: string; workspace: { root: string } }>();
    const second = {
      ...multiResourceResult.items[0],
      id: "WI-2026-021",
      title: "第三个工作项",
      repositories: [{ id: "repo-third", platform: "github" as const, projectKey: "acme/third", name: "third", defaultBranch: "main" }],
    };
    const inventory = { ...multiResourceResult, items: [multiResourceResult.items[0], second] };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => inventory), start: vi.fn(() => firstRun.promise) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { findButton(renderer!, "创建运行").props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "关闭执行配置" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "关闭工作项详情" }).props.onClick(); });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[1].props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { firstRun.reject(new Error("old run failed")); });

    expect(renderer!.root.findByProps({ "aria-label": "开始执行工作项" })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ className: "work-item-run-error" })).toHaveLength(0);
    act(() => renderer!.unmount());
  });

  it("submits only checked repositories", async () => {
    const start = vi.fn(async () => ({ runId: "run-43", workspace: { root: "/tmp/run-43" } }));
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => multiResourceResult), start }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "选择仓库：merchant-console" }).props.onChange({ target: { checked: false } }); });
    await act(async () => { findButton(renderer!, "创建运行").props.onClick(); });

    expect(start.mock.calls[0][0].repositories.map(repository => repository.name)).toEqual(["checkout-service", "deployment-config"]);
    act(() => renderer!.unmount());
  });

  it("disables creation when no repository is selected", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => multiResourceResult), start: vi.fn() }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    for (const repository of multiResourceResult.items[0].repositories ?? []) {
      await act(async () => { renderer!.root.findByProps({ "aria-label": `选择仓库：${repository.name}` }).props.onChange({ target: { checked: false } }); });
    }

    expect(findButton(renderer!, "创建运行").props.disabled).toBe(true);
    act(() => renderer!.unmount());
  });

  it("blocks an invalid selected branch but ignores it after that repository is unchecked", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => multiResourceResult), start: vi.fn() }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Base 分支：merchant-console" }).props.onChange({ target: { value: "bad branch" } }); });

    const branchInput = renderer!.root.findByProps({ "aria-label": "Base 分支：merchant-console" });
    expect(branchInput.props["aria-invalid"]).toBe(true);
    expect(branchInput.props["aria-describedby"]).toBe("base-branch-error-gitlab-acme-merchant-console");
    expect(textContent(renderer!.root.findByProps({ id: "base-branch-error-gitlab-acme-merchant-console" }))).toContain("Base 分支格式无效");
    expect(findButton(renderer!, "创建运行").props.disabled).toBe(true);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "选择仓库：merchant-console" }).props.onChange({ target: { checked: false } }); });
    expect(findButton(renderer!, "创建运行").props.disabled).toBe(false);
    act(() => renderer!.unmount());
  });

  it("resets repository drafts when reopening or switching work items", async () => {
    const second = {
      ...multiResourceResult.items[0],
      id: "WI-2026-020",
      title: "第二个工作项",
      repositories: [{ id: "repo-second", platform: "github" as const, projectKey: "acme/second", name: "second", defaultBranch: "trunk" }],
    };
    const inventory = { ...multiResourceResult, items: [multiResourceResult.items[0], second] };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => inventory), start: vi.fn() }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Base 分支：checkout-service" }).props.onChange({ target: { value: "release/changed" } }); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "选择仓库：merchant-console" }).props.onChange({ target: { checked: false } }); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "关闭执行配置" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    expect(renderer!.root.findByProps({ "aria-label": "Base 分支：checkout-service" }).props.value).toBe("main");
    expect(renderer!.root.findByProps({ "aria-label": "选择仓库：merchant-console" }).props.checked).toBe(true);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "关闭执行配置" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "关闭工作项详情" }).props.onClick(); });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[1].props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    expect(renderer!.root.findByProps({ "aria-label": "Base 分支：second" }).props.value).toBe("trunk");
    expect(renderer!.root.findAllByProps({ "aria-label": "Base 分支：checkout-service" })).toHaveLength(0);
    act(() => renderer!.unmount());
  });

  it("previews the task-isolated loop workspace before execution starts", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => multiResourceResult) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick();
    });
    await act(async () => {
      findButton(renderer!, "开始执行").props.onClick();
    });

    const executionDialog = renderer!.root.findAllByProps({ role: "dialog" }).find(node => textContent(node).includes("开始执行工作项"));
    expect(executionDialog).toBeDefined();
    expect(textContent(executionDialog!)).toContain("~/.loop-workspace/WI-2026-018/");
    expect(textContent(executionDialog!)).toContain("repositories/checkout-service");
    expect(textContent(executionDialog!)).toContain("repositories/merchant-console");
    expect(textContent(executionDialog!)).toContain("repositories/deployment-config");
    act(() => renderer!.unmount());
  });

  it("shows successful rows together with partial diagnostics", async () => {
    const partial = { ...result, complete: false, diagnostics: [{ platform: "gitlab" as const, projectKey: "corp/tools", code: "provider", message: "request failed", retryable: true }] };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => partial) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(2);
    expect(textContent(renderer!.root.findByProps({ className: "work-item-diagnostics" }))).toContain("corp/tools");
    act(() => renderer!.unmount());
  });

  it("forces a provider reload when the user clicks refresh", async () => {
    const list = vi.fn(async () => result);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "刷新工作项" }).props.onClick();
      await Promise.resolve();
    });

    expect(list).toHaveBeenNthCalledWith(1, undefined);
    expect(list).toHaveBeenNthCalledWith(2, undefined, true);
    act(() => renderer!.unmount());
  });

  it("updates the selected run history from the next inventory snapshot", async () => {
    const run = { id: "desktop-run-1", status: "running" as const, startedAt: "2026-09-23T00:00:00.000Z", workspacePath: "/tmp/workspace" };
    const initial: WorkItemInventoryResult = { ...result, items: [{ ...result.items[0], runs: [run] }] };
    const finished: WorkItemInventoryResult = { ...result, items: [{ ...result.items[0], runs: [{ ...run, status: "completed" as const }] }] };
    const list = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(finished);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });
    await act(async () => { findButton(renderer!, "运行记录").props.onClick(); });
    expect(textContent(renderer!.root.findByProps({ "aria-label": `工作项 ${initial.items[0].id}` }))).toContain("执行中");
    await act(async () => { renderer!.root.findByProps({ "aria-label": "刷新工作项" }).props.onClick(); });
    expect(textContent(renderer!.root.findByProps({ "aria-label": `工作项 ${initial.items[0].id}` }))).toContain("已完成");
    expect(list).toHaveBeenCalledTimes(2);
    act(() => renderer!.unmount());
  });

  it("loads the new run history immediately after creating a run", async () => {
    const run = { id: "desktop-run-2", status: "running" as const, startedAt: "2026-09-23T00:00:00.000Z" };
    const next: WorkItemInventoryResult = { ...multiResourceResult, items: [{ ...multiResourceResult.items[0], runs: [run] }] };
    const list = vi.fn().mockResolvedValueOnce(multiResourceResult).mockResolvedValue(next);
    const start = vi.fn(async () => ({ runId: run.id, workspace: { root: "/tmp/workspace" } }));
    vi.stubGlobal("window", { afkDesktop: { workItems: { list, start }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { renderer!.root.findByProps({ className: "backlog-row work-item-row" }).props.onClick(); });
    await act(async () => { findButton(renderer!, "开始执行").props.onClick(); });
    await act(async () => { findButton(renderer!, "创建运行").props.onClick(); });
    expect(list).toHaveBeenCalledTimes(2);
    expect(textContent(renderer!.root.findByProps({ "aria-label": "工作项 WI-2026-018" }))).toContain(run.id);
    act(() => renderer!.unmount());
  });

  it("does not replace the selected provider's items with a late result", async () => {
    const allRequest = deferred<WorkItemInventoryResult>();
    const gitlabItem = { ...result.items[0], id: "gitlab:corp/api#1", project: { platform: "gitlab" as const, projectKey: "corp/api", name: "api" }, providerRef: "gitlab:corp/api#1" };
    const gitlabResult: WorkItemInventoryResult = { items: [gitlabItem], projects: [gitlabItem.project], diagnostics: [], complete: true };
    const list = vi.fn((options?: { platform?: string }) => options?.platform === "gitlab" ? Promise.resolve(gitlabResult) : allRequest.promise);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { selectProvider(renderer!, "gitlab"); });
    expect(textContent(renderer!.root.findByProps({ className: "backlog-list" }))).toContain("corp/api");

    await act(async () => { allRequest.resolve(result); });

    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(1);
    expect(textContent(renderer!.root.findByProps({ className: "backlog-list" }))).toContain("corp/api");
    act(() => renderer!.unmount());
  });

  it("does not show an obsolete request error after switching providers", async () => {
    const allRequest = deferred<WorkItemInventoryResult>();
    const list = vi.fn((options?: { platform?: string }) => options?.platform === "gitlab"
      ? Promise.resolve({ ...result, items: [], projects: [] })
      : allRequest.promise);
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });
    await act(async () => { selectProvider(renderer!, "gitlab"); });
    await act(async () => { allRequest.reject(new Error("old GitHub failure")); });

    expect(renderer!.root.findAllByProps({ className: "backlog-alert error" })).toHaveLength(0);
    act(() => renderer!.unmount());
  });

  it("shows a bounded batch while searching the complete inventory", async () => {
    const items = Array.from({ length: 205 }, (_, index) => ({
      ...result.items[0],
      id: `github:acme/${index === 204 ? "web" : "api"}#${index + 1}`,
      issueNumber: index + 1,
      title: `Issue ${index + 1}`,
      project: index === 204 ? result.projects[1] : result.projects[0],
      providerRef: `github:acme/${index === 204 ? "web" : "api"}#${index + 1}`,
    }));
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => ({ ...result, items })) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });

    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(50);
    expect(textContent(renderer!.root.findByProps({ className: "work-items-load-more" }))).toContain("还有 155 个");
    expect(textContent(renderer!.root.findByProps({ className: "work-items-load-more" }))).toContain("继续加载");
    await act(async () => { renderer!.root.findByProps({ "aria-label": "显示更多工作项" }).props.onClick(); });
    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(100);
    expect(textContent(renderer!.root.findByProps({ className: "work-items-load-more" }))).toContain("还有 105 个");

    await act(async () => { renderer!.root.findByProps({ "aria-label": "搜索工作项" }).props.onChange({ target: { value: "Issue 205" } }); });
    const rows = renderer!.root.findAllByProps({ className: "backlog-row work-item-row" });
    expect(rows).toHaveLength(1);
    expect(textContent(rows[0])).toContain("Issue 205");
    expect(renderer!.root.findAllByProps({ "aria-label": "显示更多工作项" })).toHaveLength(0);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "搜索工作项" }).props.onChange({ target: { value: "Issue" } }); });
    expect(renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })).toHaveLength(50);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "选择仓库" }).props.onChange({ currentTarget: { value: "github:acme/web" } }); });
    const projectRows = renderer!.root.findAllByProps({ className: "backlog-row work-item-row" });
    expect(projectRows).toHaveLength(1);
    expect(textContent(projectRows[0])).toContain("Issue 205");
    act(() => renderer!.unmount());
  });

  it("uses flowing filter menus with searchable Issue sources", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => result) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });

    expect(renderer!.root.findByProps({ className: "backlog-toolbar work-items-toolbar" })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ className: "select-menu filter-trigger" })).toHaveLength(2);

    await act(async () => { renderer!.root.findByProps({ "aria-label": "选择仓库" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "aria-label": "搜索 Issue 来源" })).toBeTruthy();
    act(() => renderer!.unmount());
  });

  it("uses platform SVG icons instead of provider text in source summaries", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => result) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });

    const sourceContext = renderer!.root.findAllByProps({ className: "work-item-source-summary" })[0];
    if (!sourceContext) throw new Error("source summary not found");
    expect(sourceContext.findByProps({ "aria-label": "GitHub" })).toBeTruthy();
    expect(textContent(sourceContext)).not.toContain("GitHub Issue");
    expect(textContent(sourceContext)).toContain("acme/api #1");
    act(() => renderer!.unmount());
  });

  it("does not repeat the work item ID in the list row", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => result) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(WorkItemsPage)); });

    const row = renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0];
    expect(textContent(row)).not.toContain("github:acme/api#1");
    act(() => renderer!.unmount());
  });

  it("renders markdown description with headings, checklists and links inside detail panel", async () => {
    const markdownDescription = "## Goal\n- [ ] step one\n- [x] step two\n[acme/web#42](https://github.com/acme/web/issues/42)";
    const markdownResult: WorkItemInventoryResult = {
      ...result,
      items: [{ ...result.items[0], id: "WI-MD-001", title: "Markdown item", description: markdownDescription }],
    };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => markdownResult) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });

    const detail = renderer!.root.findByProps({ "aria-label": "工作项 WI-MD-001" });
    expect(detail.findAllByProps({ className: "markdown-content" })).toHaveLength(1);
    expect(textContent(detail)).toContain("Goal");
    expect(textContent(detail)).toContain("step one");
    expect(textContent(detail)).toContain("step two");
    expect(textContent(detail)).toContain("acme/web#42");
    act(() => renderer!.unmount());
  });

  it("shows placeholder string instead of mounting markdown when description is empty", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => result) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });

    const detail = renderer!.root.findByProps({ "aria-label": "工作项 github:acme/api#1" });
    expect(detail.findAllByProps({ className: "markdown-content" })).toHaveLength(0);
    expect(textContent(detail)).toContain("该工作项尚未补充目标描述。");
    act(() => renderer!.unmount());
  });

  it("shows provider icon next to the work item id in the detail header", async () => {
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => result) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });

    const detail = renderer!.root.findByProps({ "aria-label": "工作项 github:acme/api#1" });
    const header = detail.findByProps({ className: "work-item-detail-header" });
    const providerImg = header.findAllByType("img").find(img => img.props.src === githubIcon);
    expect(providerImg).toBeTruthy();
    act(() => renderer!.unmount());
  });

  it("shows gitlab provider icon in detail header for gitlab work items", async () => {
    const gitlabResult: WorkItemInventoryResult = {
      ...result,
      items: [{ ...result.items[0], id: "gitlab:corp/api#1", project: { platform: "gitlab" as const, projectKey: "corp/api", name: "api" }, providerRef: "gitlab:corp/api#1" }],
    };
    vi.stubGlobal("window", { afkDesktop: { workItems: { list: vi.fn(async () => gitlabResult) }, openExternal: vi.fn() } });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(WorkItemsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { renderer!.root.findAllByProps({ className: "backlog-row work-item-row" })[0].props.onClick(); });

    const detail = renderer!.root.findByProps({ "aria-label": "工作项 gitlab:corp/api#1" });
    const header = detail.findByProps({ className: "work-item-detail-header" });
    const providerImg = header.findAllByType("img").find(img => img.props.src === gitlabIcon);
    expect(providerImg).toBeTruthy();
    act(() => renderer!.unmount());
  });
});
