import { useEffect, useRef, useState } from "react";
import {
  parseLearningProjects, parseLearningCandidates, parseLearningJobs, parseLearningValidate,
  parseLearningValidationResult, parseLearningPublication, parseLearningPublicationResult, parseLearningReconciliation,
  type DesktopLearningApi, type DesktopLearningCandidate, type DesktopLearningJob, type DesktopLearningPublication,
  type DesktopLearningPublicationResult, type DesktopLearningReconciliation,
} from "../../../shared/learning-contract.js";

type LearningState = {
  projects: string[]; scope: string; candidates: DesktopLearningCandidate[]; jobs: DesktopLearningJob[];
  selectedId: string; loading: boolean; mutating: boolean; error: string; notice: string;
  preview?: DesktopLearningPublication; publication?: DesktopLearningPublicationResult; reconciliation?: DesktopLearningReconciliation;
};
type Operation = "validate" | "prepare" | "publish" | "reconcile";
const initial: LearningState = { projects: [], scope: "", candidates: [], jobs: [], selectedId: "", loading: false, mutating: false, error: "", notice: "" };
const readFailure = "学习数据读取失败，请检查项目来源、学习插件与验证／知识配置后重试。";
const writeFailure = "学习操作未确认，请重新读取数据并检查候选版本、验证／知识配置与授权后重试。";

export function useLearning(api: DesktopLearningApi | undefined, enabled: boolean) {
  const [state, setState] = useState<LearningState>(initial);
  const current = useRef(state);
  const revision = useRef(0);
  const mounted = useRef(false);
  const changing = useRef(false);
  function update(patch: Partial<LearningState>) {
    current.current = { ...current.current, ...patch };
    setState(current.current);
  }
  const active = (ticket: number) => mounted.current && revision.current === ticket;
  async function records(backend: DesktopLearningApi, scope: string) {
    const [candidates, jobs] = await Promise.all([backend.candidates({ scope }), backend.jobs({ scope })]);
    return { candidates: parseLearningCandidates(candidates).filter(candidate => candidate.scope === scope),
      jobs: parseLearningJobs(jobs).filter(job => job.scope === scope) };
  }

  async function load(scope: string, inventory: boolean) {
    if (!api || !enabled || changing.current) return;
    const ticket = ++revision.current;
    update({ scope, loading: true, error: "", notice: "", preview: undefined, publication: undefined, reconciliation: undefined,
      candidates: [], jobs: [], selectedId: "" });
    try {
      if (inventory) {
        const projects = parseLearningProjects(await api.projects());
        if (!active(ticket)) return;
        update({ projects });
        if (!projects.includes(scope)) { update({ scope: "" }); return; }
      }
      if (!scope) return;
      const result = await records(api, scope);
      if (active(ticket)) update(result);
    } catch { if (active(ticket)) update({ error: readFailure }); }
    finally { if (active(ticket)) update({ loading: false }); }
  }

  useEffect(() => {
    mounted.current = true;
    revision.current++;
    update({ ...initial, mutating: changing.current });
    if (api && enabled) {
      const ticket = revision.current;
      update({ loading: true });
      void (async () => {
        try {
          const projects = parseLearningProjects(await api.projects());
          if (active(ticket)) update({ projects });
        } catch { if (active(ticket)) update({ error: readFailure }); }
        finally { if (active(ticket)) update({ loading: false }); }
      })();
    }
    return () => { mounted.current = false; revision.current++; };
  }, [api, enabled]);

  function selectScope(scope: string) {
    if (changing.current || !current.current.projects.includes(scope)) return;
    void load(scope, false);
  }
  function selectCandidate(id: string) {
    if (changing.current || current.current.loading || !current.current.candidates.some(candidate => candidate.id === id)) return;
    revision.current++;
    update({ selectedId: id, preview: undefined, publication: undefined, reconciliation: undefined, error: "", notice: "" });
  }

  async function run(operation: Operation, checkerId = "") {
    const snapshot = current.current;
    if (!api || !enabled || !mounted.current || changing.current || snapshot.loading || !snapshot.scope) return;
    const candidate = snapshot.candidates.find(entry => entry.id === snapshot.selectedId && entry.scope === snapshot.scope);
    if (operation !== "reconcile" && !candidate) return;
    if (operation === "validate" && (!candidate || !["candidate", "conflict"].includes(candidate.state))) return;
    if (operation === "prepare" && (!candidate || candidate.state !== "validated" || !["fact", "process"].includes(candidate.kind))) return;
    const preview = snapshot.preview;
    if (operation === "publish" && (!preview || !candidate || preview.scope !== snapshot.scope || preview.candidateId !== candidate.id
      || preview.candidateVersion !== candidate.version || !["prepared", "applied"].includes(preview.phase))) return;
    let validationInput;
    try {
      if (operation === "validate" && candidate) validationInput = parseLearningValidate({ scope: snapshot.scope, candidateId: candidate.id, expectedVersion: candidate.version, checkerId });
    } catch { return; }
    changing.current = true;
    const ticket = ++revision.current;
    update({ mutating: true, error: "", notice: "", preview: undefined, publication: undefined, reconciliation: undefined });
    let next: Partial<LearningState> = {};
    try {
      let validatedVersion: number | undefined;
      if (operation === "validate" && validationInput && candidate) {
        const result = parseLearningValidationResult(await api.validate(validationInput));
        if (!active(ticket)) return;
        if (result.status === "validated" && (result.candidateId !== candidate.id || result.candidateVersion !== candidate.version)) throw new Error();
        if (result.status === "validated") validatedVersion = result.validatedVersion;
        next.notice = result.status === "validated" ? `验证通过 · v${result.candidateVersion} → v${result.validatedVersion}` : `验证受阻 · ${result.code}`;
      } else if (operation === "prepare" && candidate) {
        const result = parseLearningPublication(await api.knowledge.prepare({ scope: snapshot.scope, candidateId: candidate.id, expectedVersion: candidate.version }));
        if (!active(ticket)) return;
        if (result.scope !== snapshot.scope || result.candidateId !== candidate.id || result.candidateVersion !== candidate.version
          || (candidate.targetRef && result.targetRef !== candidate.targetRef) || !["prepared", "applied"].includes(result.phase)) throw new Error();
        next = { preview: result, notice: "知识预览已准备，发布需另行确认。" };
      } else if (operation === "publish" && preview) {
        const result = parseLearningPublicationResult(await api.knowledge.publish({ scope: snapshot.scope, key: preview.key }));
        if (!active(ticket)) return;
        if (result.publication.scope !== snapshot.scope || result.publication.candidateId !== preview.candidateId
          || result.publication.candidateVersion !== preview.candidateVersion) throw new Error();
        const notice = result.withdrawal?.status === "withdrawn" ? "知识发布已撤回，历史提交记录保留。"
          : result.withdrawal?.status === "rollback_blocked" ? "知识发布撤回受阻，需要处理恢复状态。"
          : result.errorCode !== undefined ? "知识发布返回错误，请检查发布结果。"
          : result.publication.phase === "committed" ? "知识发布已提交。" : "发布尚未提交，请检查发布状态。";
        next = { publication: result, notice };
      } else if (operation === "reconcile") {
        const result = parseLearningReconciliation(await api.knowledge.reconcile({ scope: snapshot.scope }));
        if (!active(ticket)) return;
        next = { reconciliation: { ...result, results: result.results.filter(entry => entry.publication.scope === snapshot.scope) }, notice: "知识发布核对已返回，请检查结果与阻断项。" };
      }
      if (!active(ticket)) return;
      const result = await records(api, snapshot.scope);
      if (!active(ticket)) return;
      const updated = candidate && result.candidates.find(entry => entry.id === candidate.id);
      if (operation !== "reconcile" && !updated) throw new Error();
      if (validatedVersion !== undefined && (!updated || updated.version !== validatedVersion || updated.state !== "validated")) throw new Error();
      if (next.preview && (!updated || updated.version !== next.preview.candidateVersion || updated.state !== "validated")) throw new Error();
      if (next.publication && updated && (updated.version < next.publication.publication.candidateVersion
        || (next.publication.publication.phase === "committed" && updated.version === next.publication.publication.candidateVersion))) throw new Error();
      if (next.reconciliation) {
        const results = next.reconciliation.results;
        if (results.some(entry => entry.withdrawal?.status === "rollback_blocked")) next.notice = "知识发布核对发现撤回受阻，请处理恢复状态。";
        else if (results.some(entry => entry.withdrawal?.status === "withdrawn")) next.notice = "知识发布核对包含已撤回记录，历史提交不表示当前发布成功。";
        else if (results.some(entry => entry.errorCode !== undefined)) next.notice = "知识发布核对返回错误，请检查结果与阻断项。";
      }
      update({ ...result, ...next });
    } catch {
      if (active(ticket)) update({ error: writeFailure, candidates: [], jobs: [], selectedId: "", preview: undefined,
        publication: next.publication, reconciliation: next.reconciliation });
    } finally {
      changing.current = false;
      if (mounted.current) update({ mutating: false });
    }
  }

  return { ...state, selected: state.candidates.find(candidate => candidate.id === state.selectedId), selectScope, selectCandidate,
    refresh: () => load(current.current.scope, true), validate: (checkerId: string) => run("validate", checkerId),
    prepare: () => run("prepare"), publish: () => run("publish"), reconcile: () => run("reconcile") };
}
