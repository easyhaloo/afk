import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopLearningApi, DesktopLearningCandidate, DesktopLearningPublication } from "../shared/learning-contract.js";
import { SelectMenu } from "../src/components/SelectMenu.js";
import { LearningView } from "../src/features/learning/LearningView.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = "github:acme/api";
const other = "github:acme/other";
const candidateId = "a".repeat(64);
const key = "b".repeat(64);
const candidate: DesktopLearningCandidate = { id: candidateId, requestKey: "c".repeat(64), scope, version: 2, state: "candidate", kind: "fact", title: "Approval rule", evidenceCount: 2, targetRef: "wiki:approval" };
const publication: DesktopLearningPublication = { key, scope, candidateId, candidateVersion: 3, targetRef: "wiki:approval", phase: "prepared" };
const renderers: ReturnType<typeof create>[] = [];
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()); vi.unstubAllGlobals(); });

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  let rows = [candidate];
  const api = {
    projects: vi.fn(async () => [scope, other]),
    jobs: vi.fn(async () => [{ jobId: key, scope, status: "blocked" as const, attemptCount: 1 }]),
    candidates: vi.fn(async () => rows),
    validate: vi.fn(async (): Promise<Awaited<ReturnType<DesktopLearningApi["validate"]>>> => {
      rows = [{ ...candidate, state: "validated", version: 3 }];
      return { status: "validated" as const, candidateId, candidateVersion: 2, validatedVersion: 3 };
    }),
    knowledge: {
      prepare: vi.fn(async () => publication),
      publish: vi.fn(async (): Promise<Awaited<ReturnType<DesktopLearningApi["knowledge"]["publish"]>>> => {
        rows = [{ ...candidate, state: "published", version: 4 }];
        return { publication: { ...publication, phase: "committed" as const }, wikiStatus: "applied" as const };
      }),
      reconcile: vi.fn(async (): Promise<Awaited<ReturnType<DesktopLearningApi["knowledge"]["reconcile"]>>> => ({ results: [], blocked: [{ code: "knowledge_grant_unavailable" as const }] })),
    },
  } satisfies DesktopLearningApi;
  return { api, get rows() { return rows; }, set rows(value) { rows = value; } };
}

async function render(api?: DesktopLearningApi, enabled = true) {
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(LearningView, { api, enabled })); });
  renderers.push(renderer);
  return renderer;
}
const text = (renderer: ReturnType<typeof create>) => JSON.stringify(renderer.toJSON());
async function selectScope(renderer: ReturnType<typeof create>, value = scope) {
  await act(async () => { renderer.root.findByType(SelectMenu).props.onChange(value); });
}
function button(renderer: ReturnType<typeof create>, label: string) { return renderer.root.findByProps({ "aria-label": label }); }
async function click(renderer: ReturnType<typeof create>, label: string) { await act(async () => { button(renderer, label).props.onClick(); }); }
function selectCandidate(renderer: ReturnType<typeof create>) { act(() => { button(renderer, `选择候选 ${candidateId}`).props.onClick(); }); }
function checker(renderer: ReturnType<typeof create>, value = "verify.approval") {
  act(() => { renderer.root.findByProps({ "aria-label": "验证器 ID" }).props.onChange({ target: { value } }); });
}

describe("learning governance view", () => {
  it.each(["publish", "reconcile"] as const)("retains %s withdrawal receipts when refreshing jobs fails", async operation => {
    for (const status of ["withdrawn", "rollback_blocked"] as const) {
      const data = fixture();
      data.rows = [{ ...candidate, state: "validated", version: 3 }];
      const result = { publication: { ...publication, phase: "committed" as const }, withdrawal: { status } };
      data.api.knowledge.publish.mockImplementationOnce(async () => {
        data.api.jobs.mockRejectedValueOnce(new Error("SECRET_REFRESH_ERROR"));
        return result;
      });
      data.api.knowledge.reconcile.mockImplementationOnce(async () => {
        data.api.jobs.mockRejectedValueOnce(new Error("SECRET_REFRESH_ERROR"));
        return { results: [result], blocked: [] };
      });
      const renderer = await render(data.api);
      await selectScope(renderer); selectCandidate(renderer);
      if (operation === "publish") await click(renderer, "准备知识预览");
      await click(renderer, operation === "publish" ? "发布知识" : "核对知识发布");
      expect(text(renderer)).toContain(status === "withdrawn" ? "已撤回" : "撤回受阻");
      expect(text(renderer)).toContain(key);
      expect(text(renderer)).not.toContain("SECRET_REFRESH_ERROR");
      expect(button(renderer, "发布知识").props.disabled).toBe(true);
      expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    }
  });

  it("retains same-project reconciliation outside the visible candidate page", async () => {
    const { api } = fixture();
    const hiddenId = "f".repeat(64);
    api.knowledge.reconcile.mockResolvedValueOnce({ results: [{ publication: { ...publication, candidateId: hiddenId,
      phase: "committed" }, withdrawal: { status: "rollback_blocked" } }], blocked: [] });
    const renderer = await render(api);
    await selectScope(renderer);
    await click(renderer, "核对知识发布");
    expect(text(renderer)).toContain(hiddenId);
    expect(text(renderer)).toContain("撤回受阻");
  });

  it("shows unavailable and disabled states without manufacturing a runtime or enabling it", async () => {
    const unavailable = await render();
    expect(text(unavailable)).toContain("学习后端未接入");
    const { api } = fixture();
    const disabled = await render(api, false);
    expect(text(disabled)).toContain("学习治理未启用");
    expect(api.projects).not.toHaveBeenCalled();
  });

  it("requires explicit inventory scope, displays candidate/job metadata, and never starts mutations while querying", async () => {
    const { api } = fixture();
    const renderer = await render(api);
    expect(api.candidates).not.toHaveBeenCalled();
    expect(renderer.root.findByType(SelectMenu).props.search).toBeTruthy();
    await selectScope(renderer);
    expect(api.candidates).toHaveBeenCalledWith({ scope });
    expect(api.jobs).toHaveBeenCalledWith({ scope });
    expect(text(renderer)).toContain("Approval rule");
    expect(text(renderer)).toContain("待验证");
    expect(text(renderer)).toContain("受阻");
    expect(api.validate).not.toHaveBeenCalled();
    expect(api.knowledge.prepare).not.toHaveBeenCalled();
    expect(api.knowledge.publish).not.toHaveBeenCalled();
    expect(api.knowledge.reconcile).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("input").map((input: { props: { "aria-label"?: string } }) => input.props["aria-label"])).not.toContain("命令");
  });

  it("validates exact identity/version, prepares metadata, and publishes only after explicit preview", async () => {
    const { api } = fixture();
    const renderer = await render(api);
    await selectScope(renderer);
    selectCandidate(renderer);
    expect(button(renderer, "验证候选").props.disabled).toBe(true);
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
    checker(renderer);
    await click(renderer, "验证候选");
    expect(api.validate).toHaveBeenCalledWith({ scope, candidateId, expectedVersion: 2, checkerId: "verify.approval" });
    expect(text(renderer)).toContain("验证通过");
    await click(renderer, "准备知识预览");
    expect(api.knowledge.prepare).toHaveBeenCalledWith({ scope, candidateId, expectedVersion: 3 });
    expect(api.knowledge.publish).not.toHaveBeenCalled();
    expect(text(renderer)).toContain(key);
    expect(text(renderer)).toContain("不包含页面正文或内容差异");
    await click(renderer, "发布知识");
    expect(api.knowledge.publish).toHaveBeenCalledWith({ scope, key });
    expect(text(renderer)).toContain("已提交");
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
    expect(renderer.root.findAllByType("button").some((entry: { props: { "aria-label"?: string } }) => /撤销/.test(entry.props["aria-label"] ?? ""))).toBe(false);
  });

  it("preserves genuine blocked validation status/code and shows reconciliation blockers", async () => {
    const { api } = fixture();
    api.validate.mockResolvedValueOnce({ status: "blocked", code: "insufficient_evidence" });
    const renderer = await render(api);
    await selectScope(renderer); selectCandidate(renderer); checker(renderer);
    await click(renderer, "验证候选");
    expect(text(renderer)).toContain("insufficient_evidence");
    expect(text(renderer)).not.toContain("验证通过");
    await click(renderer, "核对知识发布");
    expect(api.knowledge.reconcile).toHaveBeenCalledWith({ scope });
    expect(text(renderer)).toContain("knowledge_grant_unavailable");
  });

  it("rejects command-like checker identifiers before dispatch and offers no arbitrary target path input", async () => {
    const { api } = fixture();
    const renderer = await render(api);
    await selectScope(renderer); selectCandidate(renderer); checker(renderer, "test; exit 0");
    expect(button(renderer, "验证候选").props.disabled).toBe(true);
    await click(renderer, "验证候选");
    expect(api.validate).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("input").map((input: { props: { "aria-label"?: string } }) => input.props["aria-label"])).toEqual(["验证器 ID"]);
  });

  it("discards out-of-order project queries and clears previous selection and preview", async () => {
    const { api } = fixture();
    const pending = deferred<DesktopLearningCandidate[]>();
    api.candidates.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce([{ ...candidate, scope: other, title: "Other rule" }]);
    const renderer = await render(api);
    await selectScope(renderer);
    await selectScope(renderer, other);
    await act(async () => { pending.resolve([candidate]); });
    expect(text(renderer)).toContain("Other rule");
    expect(text(renderer)).not.toContain("Approval rule");
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
  });

  it("filters wrong-scope records even when an injected query returns a mixed batch", async () => {
    const { api } = fixture();
    api.candidates.mockResolvedValueOnce([candidate, { ...candidate, id: "f".repeat(64), scope: other, title: "Foreign private title" }]);
    const renderer = await render(api);
    await selectScope(renderer);
    expect(text(renderer)).not.toContain("Foreign private title");
  });

  it("guards same-tick duplicate mutations and does not publish automatically", async () => {
    const { api } = fixture();
    const pending = deferred<Awaited<ReturnType<DesktopLearningApi["validate"]>>>();
    api.validate.mockImplementationOnce(() => pending.promise);
    const renderer = await render(api);
    await selectScope(renderer); selectCandidate(renderer); checker(renderer);
    await act(async () => { const handler = button(renderer, "验证候选").props.onClick; handler(); handler(); });
    expect(api.validate).toHaveBeenCalledTimes(1);
    expect(button(renderer, "核对知识发布").props.disabled).toBe(true);
    expect(renderer.root.findByType(SelectMenu).props.disabled).toBe(true);
    await act(async () => { pending.resolve({ status: "blocked", code: "cancelled" }); });
    expect(api.knowledge.publish).not.toHaveBeenCalled();
    expect(button(renderer, "核对知识发布").props.disabled).toBe(false);
  });

  it("does not run late follow-up queries or display stale success after API replacement", async () => {
    const { api } = fixture();
    const next = fixture();
    const pending = deferred<Awaited<ReturnType<DesktopLearningApi["validate"]>>>();
    api.validate.mockImplementationOnce(() => pending.promise);
    const renderer = await render(api);
    await selectScope(renderer); selectCandidate(renderer); checker(renderer);
    await click(renderer, "验证候选");
    const count = api.candidates.mock.calls.length;
    await act(async () => { renderer.update(createElement(LearningView, { api: next.api })); });
    await act(async () => { pending.resolve({ status: "validated", candidateId, candidateVersion: 2, validatedVersion: 3 }); });
    expect(api.candidates).toHaveBeenCalledTimes(count);
    expect(text(renderer)).not.toContain("验证通过");
    expect(text(renderer)).not.toContain("Approval rule");
  });

  it("clears prepared publication on refresh/version change and shows inventory removal", async () => {
    const data = fixture();
    data.rows = [{ ...candidate, state: "validated", version: 3 }];
    const renderer = await render(data.api);
    await selectScope(renderer); selectCandidate(renderer);
    await click(renderer, "准备知识预览");
    expect(button(renderer, "发布知识").props.disabled).toBe(false);
    data.api.projects.mockResolvedValueOnce([]);
    await click(renderer, "重新读取学习数据");
    expect(text(renderer)).not.toContain(key);
    expect(text(renderer)).not.toContain("Approval rule");
    expect(text(renderer)).toContain("暂无可用项目");
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
  });

  it("uses fixed safe error text and retains a local retry without claiming configuration is present", async () => {
    const { api } = fixture();
    api.candidates.mockRejectedValueOnce(new Error("SECRET /private/vault knowledge_not_configured"));
    const renderer = await render(api);
    await selectScope(renderer);
    expect(text(renderer)).not.toContain("SECRET");
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("配置");
    await click(renderer, "重新读取学习数据");
    expect(text(renderer)).toContain("Approval rule");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("renders empty records and unconfigured-project inventory states explicitly", async () => {
    const { api } = fixture();
    api.projects.mockResolvedValueOnce([]);
    const empty = await render(api);
    expect(text(empty)).toContain("暂无可用项目");
    const data = fixture();
    data.rows = []; data.api.jobs.mockResolvedValueOnce([]);
    const renderer = await render(data.api);
    await selectScope(renderer);
    expect(text(renderer)).toContain("暂无学习候选");
    expect(text(renderer)).toContain("暂无学习任务");
  });

  it("does not report validation success when the refreshed candidate has not reached the receipt version", async () => {
    const { api } = fixture();
    api.validate.mockResolvedValueOnce({ status: "validated", candidateId, candidateVersion: 2, validatedVersion: 3 });
    const renderer = await render(api);
    await selectScope(renderer); selectCandidate(renderer); checker(renderer);
    await click(renderer, "验证候选");
    expect(text(renderer)).not.toContain("验证通过");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  });

  it("does not let a late query failure erase the next project's records or busy state", async () => {
    const { api } = fixture();
    const pending = deferred<DesktopLearningCandidate[]>();
    api.candidates.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce([{ ...candidate, scope: other, title: "Other rule" }]);
    const renderer = await render(api);
    await selectScope(renderer); await selectScope(renderer, other);
    await act(async () => { pending.reject(new Error("SECRET old scope")); });
    expect(text(renderer)).toContain("Other rule");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(button(renderer, "重新读取学习数据").props.disabled).toBe(false);
  });

  it("does not issue follow-up reads when a pending operation settles after unmount", async () => {
    const { api } = fixture();
    const pending = deferred<Awaited<ReturnType<DesktopLearningApi["validate"]>>>();
    api.validate.mockImplementationOnce(() => pending.promise);
    const renderer = await render(api);
    await selectScope(renderer); selectCandidate(renderer); checker(renderer);
    await click(renderer, "验证候选");
    const count = api.candidates.mock.calls.length;
    act(() => renderer.unmount());
    await act(async () => { pending.resolve({ status: "blocked", code: "cancelled" }); });
    expect(api.candidates).toHaveBeenCalledTimes(count);
  });

  it("discards a foreign prepare receipt and never leaves a publishable preview after failure", async () => {
    const data = fixture();
    data.rows = [{ ...candidate, state: "validated", version: 3 }];
    data.api.knowledge.prepare.mockResolvedValueOnce({ ...publication, scope: other });
    const renderer = await render(data.api);
    await selectScope(renderer); selectCandidate(renderer);
    await click(renderer, "准备知识预览");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(text(renderer)).not.toContain(key);
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
    await click(renderer, "发布知识");
    expect(data.api.knowledge.publish).not.toHaveBeenCalled();
  });

  it("invalidates a prepared key when another candidate is selected", async () => {
    const data = fixture();
    const secondId = "f".repeat(64);
    data.rows = [{ ...candidate, state: "validated", version: 3 }, { ...candidate, id: secondId, title: "Second rule" }];
    const renderer = await render(data.api);
    await selectScope(renderer); selectCandidate(renderer);
    await click(renderer, "准备知识预览");
    expect(button(renderer, "发布知识").props.disabled).toBe(false);
    await click(renderer, `选择候选 ${secondId}`);
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ "aria-label": "知识预览" })).toHaveLength(0);
    await click(renderer, "准备知识预览");
    expect(data.api.knowledge.prepare).toHaveBeenCalledTimes(1);
  });

  it("retains the real conflict/recovery result instead of announcing a successful publish", async () => {
    const data = fixture();
    data.rows = [{ ...candidate, state: "validated", version: 3 }];
    data.api.knowledge.publish.mockResolvedValueOnce({ publication: { ...publication, phase: "conflict" }, errorCode: 4, withdrawal: { status: "rollback_blocked" } });
    const renderer = await render(data.api);
    await selectScope(renderer); selectCandidate(renderer);
    await click(renderer, "准备知识预览"); await click(renderer, "发布知识");
    expect(text(renderer)).toContain("撤回受阻");
    expect(text(renderer)).toContain("回退受阻");
    expect(text(renderer)).not.toContain("知识发布已提交");
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
  });

  it.each(["withdrawn", "rollback_blocked"] as const)("prioritizes %s over a historical committed publish result", async status => {
    const data = fixture();
    data.rows = [{ ...candidate, state: "validated", version: 3 }];
    data.api.knowledge.publish.mockImplementationOnce(async () => {
      data.rows = [{ ...candidate, state: "conflict", version: 5 }];
      return { publication: { ...publication, phase: "committed" }, withdrawal: { status } };
    });
    const renderer = await render(data.api);
    await selectScope(renderer); selectCandidate(renderer);
    await click(renderer, "准备知识预览"); await click(renderer, "发布知识");
    const outcome = status === "withdrawn" ? "已撤回" : "撤回受阻";
    expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain(outcome);
    expect(text(renderer)).not.toContain("知识发布已提交。");
    const result = renderer.root.findByProps({ "aria-label": "本次发布结果" });
    expect(result.findByType("b").children.join("")).toBe(outcome);
    expect(JSON.stringify(result.findAllByType("small").map((entry: { children: unknown[] }) => entry.children))).toContain("历史发布阶段：");
    expect(text(renderer)).toContain("已提交");
    expect(text(renderer)).toContain(key);
    expect(button(renderer, "发布知识").props.disabled).toBe(true);
  });

  it.each(["withdrawn", "rollback_blocked"] as const)("shows reconciled committed + %s as a withdrawal, retaining its history", async status => {
    const data = fixture();
    data.rows = [{ ...candidate, state: "conflict", version: 5 }];
    data.api.knowledge.reconcile.mockResolvedValueOnce({ results: [{ publication: { ...publication, phase: "committed" }, withdrawal: { status } }], blocked: [] });
    const renderer = await render(data.api);
    await selectScope(renderer); await click(renderer, "核对知识发布");
    const outcome = status === "withdrawn" ? "已撤回" : "撤回受阻";
    expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain(outcome);
    const results = renderer.root.findByProps({ "aria-label": "核对发布结果" });
    expect(results.findByType("b").children.join("")).toBe(outcome);
    expect(text(renderer)).toContain("历史发布阶段：");
    expect(text(renderer)).toContain("已提交");
    expect(text(renderer)).not.toContain("知识发布已提交。");
    expect(text(renderer)).toContain(key);
  });

  it.each(["publish", "reconcile"] as const)("does not announce success for %s committed metadata accompanied by an error", async operation => {
    const data = fixture();
    data.rows = [{ ...candidate, state: "validated", version: 3 }];
    const result = { publication: { ...publication, phase: "committed" as const }, errorCode: 4 };
    data.api.knowledge.publish.mockImplementationOnce(async () => { data.rows = [{ ...candidate, state: "conflict", version: 5 }]; return result; });
    data.api.knowledge.reconcile.mockResolvedValueOnce({ results: [result], blocked: [] });
    const renderer = await render(data.api);
    await selectScope(renderer);
    if (operation === "publish") {
      selectCandidate(renderer);
      await click(renderer, "准备知识预览"); await click(renderer, "发布知识");
    } else await click(renderer, "核对知识发布");
    expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain("错误");
    expect(text(renderer)).not.toContain("知识发布已提交。");
    expect(text(renderer)).toContain("历史发布阶段：");
    expect(text(renderer)).toContain("已提交");
  });

  it("accepts a legitimate successor key and keeps its committed metadata", async () => {
    const data = fixture();
    data.rows = [{ ...candidate, state: "validated", version: 3 }];
    const successorKey = "d".repeat(64);
    data.api.knowledge.publish.mockImplementationOnce(async () => {
      data.rows = [{ ...candidate, state: "published", version: 4 }];
      return { publication: { ...publication, key: successorKey, phase: "committed" }, wikiStatus: "unchanged" };
    });
    const renderer = await render(data.api);
    await selectScope(renderer); selectCandidate(renderer);
    await click(renderer, "准备知识预览"); await click(renderer, "发布知识");
    expect(text(renderer)).toContain(successorKey);
    expect(text(renderer)).toContain("知识发布已提交");
  });

  it("keeps unsupported candidates read-only for knowledge publication and uses an accessible local refresh", async () => {
    const data = fixture();
    data.rows = [{ ...candidate, kind: "tool", state: "validated", version: 3 }];
    const renderer = await render(data.api);
    await selectScope(renderer); selectCandidate(renderer);
    expect(text(renderer)).toContain("此类候选当前不支持知识发布");
    expect(button(renderer, "准备知识预览").props.disabled).toBe(true);
    expect(button(renderer, "重新读取学习数据").props.title).toBeTruthy();
    const pageHeader = renderer.root.findAllByType("header")[0];
    expect(pageHeader.findAllByType("button")).toHaveLength(0);
  });

  it("does not accept an older inventory response after replacing the backend", async () => {
    const first = fixture();
    const next = fixture();
    const pending = deferred<string[]>();
    first.api.projects.mockImplementationOnce(() => pending.promise);
    next.api.projects.mockResolvedValueOnce([other]);
    const renderer = await render(first.api);
    await act(async () => { renderer.update(createElement(LearningView, { api: next.api })); });
    await act(async () => { pending.resolve([scope]); });
    expect(renderer.root.findByType(SelectMenu).props.options.map((option: { value: string }) => option.value)).toEqual([other]);
    expect(renderer.root.findByType(SelectMenu).props.value).toBe("");
    expect(first.api.candidates).not.toHaveBeenCalled();
  });

  it("invalidates pending work when the view is disabled and prevents new actions", async () => {
    const { api } = fixture();
    const pending = deferred<Awaited<ReturnType<DesktopLearningApi["validate"]>>>();
    api.validate.mockImplementationOnce(() => pending.promise);
    const renderer = await render(api);
    await selectScope(renderer); selectCandidate(renderer); checker(renderer);
    await click(renderer, "验证候选");
    const count = api.candidates.mock.calls.length;
    await act(async () => { renderer.update(createElement(LearningView, { api, enabled: false })); });
    await act(async () => { pending.resolve({ status: "blocked", code: "cancelled" }); });
    expect(text(renderer)).toContain("学习治理未启用");
    expect(text(renderer)).not.toContain("Approval rule");
    expect(api.candidates).toHaveBeenCalledTimes(count);
    expect(button(renderer, "核对知识发布").props.disabled).toBe(true);
  });
});
