import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExperience } from "../shared/experience-contract.js";
import { SelectMenu } from "../src/components/SelectMenu.js";
import { ExperienceSettings } from "../src/features/settings/ExperienceSettings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
const record: DesktopExperience = { id: "e79b6ea0-a82d-4639-9f0e-a358eedbe2aa", scope: "github:acme/api", status: "candidate", trigger: "network.failure", rootCause: "timeout", action: "configure proxy", evidence: ["run:original#failure.classified"], source: { runId: "original", workItemId: "github:acme/api#1" }, expiresAt: "2099-01-01T00:00:00Z", occurrences: 1 };

async function render() {
  const experiences = { projects: vi.fn().mockResolvedValue([record.scope, "github:acme/other"]), list: vi.fn().mockResolvedValue([record]), verify: vi.fn().mockResolvedValue({ ...record, status: "verified" }), revoke: vi.fn().mockResolvedValue({ ...record, status: "revoked" }) };
  vi.stubGlobal("window", { afkDesktop: { experiences } });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(ExperienceSettings)); });
  return { renderer, experiences };
}

describe("experience settings", () => {
  it("requires a real project selection and sends explicit scoped list/recall queries", async () => {
    const { renderer, experiences } = await render();
    expect(experiences.list).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ "aria-label": "查询经验" }).props.disabled).toBe(true);
    await act(async () => { renderer.root.findByType(SelectMenu).props.onChange(record.scope); });
    expect(experiences.list).toHaveBeenCalledWith({ scope: record.scope });
    expect(JSON.stringify(renderer.toJSON())).toContain("run:original#failure.classified");
    act(() => renderer.root.findByProps({ "aria-label": "召回内容" }).props.onChange({ target: { value: "network" } }));
    experiences.list.mockResolvedValueOnce([]);
    await act(async () => { renderer.root.findAllByType("form")[0].props.onSubmit({ preventDefault: vi.fn() }); });
    expect(experiences.list).toHaveBeenLastCalledWith({ scope: record.scope, prompt: "network" });
    expect(JSON.stringify(renderer.toJSON())).toContain("召回结果");
    expect(JSON.stringify(renderer.toJSON())).toContain("没有匹配记录");
    act(() => renderer.unmount());
  });

  it("requires an independent run and explicit correction, retains failures for retry and confirms revoke", async () => {
    const { renderer, experiences } = await render();
    await act(async () => { renderer.root.findByType(SelectMenu).props.onChange(record.scope); });
    act(() => renderer.root.findByProps({ "aria-label": `验证 ${record.id}` }).props.onClick());
    expect(renderer.root.findAllByType("button").find(button => button.children.includes("验证并保存"))!.props.disabled).toBe(true);
    act(() => renderer.root.findByProps({ "aria-label": "独立验证运行" }).props.onChange({ target: { value: "independent-qa" } }));
    act(() => renderer.root.findByProps({ "aria-label": "已验证修正" }).props.onChange({ target: { value: "correct network" } }));
    experiences.verify.mockRejectedValueOnce(new Error("需要同一项目的独立 QA 运行"));
    await act(async () => { renderer.root.findByProps({ "aria-label": "独立验证经验" }).props.onSubmit({ preventDefault: vi.fn() }); });
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("独立 QA");
    expect(renderer.root.findByProps({ "aria-label": "已验证修正" }).props.value).toBe("correct network");
    await act(async () => { renderer.root.findByProps({ "aria-label": "独立验证经验" }).props.onSubmit({ preventDefault: vi.fn() }); });
    expect(experiences.verify).toHaveBeenLastCalledWith({ scope: record.scope, id: record.id, runId: "independent-qa", action: "correct network" });
    expect(renderer.root.findAllByProps({ "aria-label": "独立验证经验" })).toHaveLength(0);
    act(() => renderer.root.findByProps({ "aria-label": `撤销 ${record.id}` }).props.onClick());
    expect(experiences.revoke).not.toHaveBeenCalled();
    await act(async () => { renderer.root.findByProps({ "aria-label": "确认撤销经验" }).props.onClick(); });
    expect(experiences.revoke).toHaveBeenCalledWith({ scope: record.scope, id: record.id });
    act(() => renderer.unmount());
  });

  it("discards an older project response after selection changes", async () => {
    const { renderer, experiences } = await render();
    let finish!: (records: DesktopExperience[]) => void;
    experiences.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => renderer.root.findByType(SelectMenu).props.onChange(record.scope));
    experiences.list.mockResolvedValueOnce([]);
    await act(async () => { renderer.root.findByType(SelectMenu).props.onChange("github:acme/other"); });
    await act(async () => { finish([record]); });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("network.failure");
    expect(renderer.root.findByType(SelectMenu).props.value).toBe("github:acme/other");
    expect(renderer.root.findByProps({ "aria-label": "查询经验" }).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it("disables revoked verification and shows project discovery errors with refresh", async () => {
    const { renderer, experiences } = await render();
    experiences.list.mockResolvedValueOnce([{ ...record, status: "revoked" }]);
    await act(async () => { renderer.root.findByType(SelectMenu).props.onChange(record.scope); });
    expect(renderer.root.findByProps({ "aria-label": `验证 ${record.id}` }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ "aria-label": `撤销 ${record.id}` }).props.disabled).toBe(true);
    experiences.projects.mockRejectedValueOnce(new Error("请检查 Provider 配置"));
    await act(async () => { renderer.root.findByProps({ "aria-label": "刷新经验" }).props.onClick(); });
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Provider 配置");
    act(() => renderer.unmount());
  });

  it("clears records and loading state when the current project is removed from inventory", async () => {
    const { renderer, experiences } = await render();
    await act(async () => { renderer.root.findByType(SelectMenu).props.onChange(record.scope); });
    experiences.projects.mockResolvedValueOnce([]);
    await act(async () => { renderer.root.findByProps({ "aria-label": "刷新经验" }).props.onClick(); });
    expect(renderer.root.findByType(SelectMenu).props.value).toBe("");
    expect(renderer.root.findByProps({ "aria-label": "刷新经验" }).props.disabled).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("network.failure");
    act(() => renderer.unmount());
  });
});
