import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agents, Environments, Repositories } from "../src/main";
import { DEMO_SNAPSHOT } from "../src/mock-data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

describe("resource search pages", () => {
  it("filters authorized repositories without requesting provider data again", async () => {
    const list = vi.fn(async () => ({ projects: [{ platform: "github", projectKey: "acme/api", name: "API", defaultBranch: "main" }, { platform: "gitlab", projectKey: "acme/web", name: "Web" }] }));
    vi.stubGlobal("window", { afkDesktop: { workItems: { list }, openExternal: vi.fn() } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(Repositories)); });
    act(() => renderer.root.findByProps({ "aria-label": "搜索代码仓库" }).props.onChange({ target: { value: "web" } }));
    expect(renderer.root.findAllByProps({ className: "repository-row" })).toHaveLength(1);
    expect(list).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it("keeps runtime availability separate from the resource search", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(Agents, { snapshot: DEMO_SNAPSHOT, loading: false, lastCheckedAt: null, onRefresh: vi.fn() })); });
    act(() => renderer.root.findByProps({ "aria-label": "搜索 Agent" }).props.onChange({ target: { value: "codex" } }));
    expect(renderer.root.findAllByProps({ className: "agent-runtime available" })).toHaveLength(1);
    const group = renderer.root.findByProps({ role: "radiogroup", "aria-label": "Agent 可用状态" });
    act(() => group.findAllByProps({ role: "radio" })[2].props.onClick());
    expect(renderer.root.findAllByProps({ className: "agent-runtime available" })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("searches registered environment resources and preserves session targets", () => {
    const onTerminal = vi.fn();
    const snapshot = { ...DEMO_SNAPSHOT, sessions: [{ name: "session-special", workspace: "/tmp/project", windows: 1, attached: false, runId: "run-144", resourceId: "resource-144" }] };
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(Environments, { snapshot, onTerminal })); });
    act(() => renderer.root.findByProps({ "aria-label": "搜索执行环境" }).props.onChange({ target: { value: "special" } }));
    const rows = renderer.root.findAllByProps({ className: "env-row" });
    expect(rows).toHaveLength(1);
    act(() => rows[0].findByType("button").props.onClick());
    expect(onTerminal).toHaveBeenCalledWith("session-special", "/tmp/project", "run-144", "resource-144");
    act(() => renderer.unmount());
  });
});
