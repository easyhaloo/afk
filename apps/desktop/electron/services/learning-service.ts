import type { PluginRuntime } from "@afk/runtime/plugin-sdk";
import type { LearningCandidate } from "@afk/runtime/execution";
import { assertExactKeys, parseObject } from "../../shared/validation.js";
import { parseNoInput } from "../../shared/experience-contract.js";
import { LEARNING_LIMITS, parseLearningQuery, parseLearningValidate, parseKnowledgePrepare, parseKnowledgePublish,
  parseLearningProjects, parseLearningJob, parseLearningCandidate, parseLearningJobs, parseLearningCandidates,
  parseLearningValidationResult, parseLearningPublication, parseLearningPublicationResult, parseLearningReconciliation,
  parseLearningCorrectionInput, parseLearningCorrectionResult, parseLearningWorkerTarget, parseLearningWorkerResult,
  type DesktopLearningApi, type DesktopLearningCandidate, type DesktopLearningPublication, type LearningQuery,
  type DesktopLearningWorkerResult, type LearningWorkerTarget } from "../../shared/learning-contract.js";

export type LearningServiceOptions = {
  projects: () => Promise<string[]>;
  withRuntime: <Result>(operation: (runtime: Pick<PluginRuntime, "dispatchSystemAction">) => Promise<Result>) => Promise<Result>;
  launchWorker?: (target: LearningWorkerTarget, signal: AbortSignal) => Promise<unknown>;
};

class SelectionUnavailable extends Error {}
type MutationAction = "learning.correct" | "learning.validate" | "learning.knowledge.prepare" | "learning.knowledge.publish" | "learning.knowledge.reconcile";
type Dispatch = PluginRuntime["dispatchSystemAction"];

function batch(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > LEARNING_LIMITS.backendRecords) throw new Error();
  return value;
}

export function projectLearningJob(value: unknown) {
  const job = parseObject(value, "job");
  return parseLearningJob({ jobId: job.jobId, scope: job.scope, status: job.status, attemptCount: batch(job.attempts).length, canRun: job.canRun });
}

function candidateProjection(value: unknown, scope: string): DesktopLearningCandidate | undefined {
  const input = parseObject(value, "candidate");
  const proposal = parseObject(input.proposal, "proposal");
  const applicability = parseObject(proposal.applicability, "applicability");
  if (typeof applicability.project !== "string") throw new Error();
  if (applicability.project !== scope) return undefined;
  const evidence = batch(proposal.evidenceIds);
  const projection = { id: input.id, requestKey: input.requestKey, scope, version: input.version, state: input.state,
    kind: proposal.kind, title: proposal.title, evidenceCount: evidence.length, ...(proposal.targetRef === undefined ? {} : { targetRef: proposal.targetRef }) };
  return parseLearningCandidate(projection);
}

function candidateProjections(records: unknown, scope: string): DesktopLearningCandidate[] {
  const result: DesktopLearningCandidate[] = [];
  for (const record of batch(records)) {
    const candidate = candidateProjection(record, scope);
    if (candidate) result.push(candidate);
  }
  return result;
}

function publicationProjection(value: unknown, scope: string, candidates: readonly DesktopLearningCandidate[]): DesktopLearningPublication {
  const input = parseObject(value, "publication");
  const candidate = candidates.find(entry => entry.id === input.candidateId && entry.scope === scope);
  if (!candidate) throw new Error();
  const publication = parseLearningPublication({ key: input.key, scope, candidateId: input.candidateId, candidateVersion: input.candidateVersion,
    targetRef: input.targetRef, phase: input.phase, ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }) });
  if (publication.candidateVersion > candidate.version) throw new Error();
  return publication;
}

function resultProjection(value: unknown, scope: string, candidates: readonly DesktopLearningCandidate[]) {
  const input = parseObject(value, "publication result");
  const withdrawal = input.withdrawal === undefined ? undefined : parseObject(input.withdrawal, "withdrawal");
  return parseLearningPublicationResult({ publication: publicationProjection(input.publication, scope, candidates),
    ...(input.wikiStatus === undefined ? {} : { wikiStatus: input.wikiStatus }), ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(withdrawal === undefined ? {} : { withdrawal: { status: withdrawal.status } }),
    ...(input.experienceProjection === undefined ? {} : { experienceProjection: input.experienceProjection }) });
}

export function createLearningService(options: LearningServiceOptions): DesktopLearningApi & { stopWorker(): Promise<void> | undefined } {
  let activeWorker: { target: LearningWorkerTarget; controller: AbortController; done: Promise<DesktopLearningWorkerResult> } | undefined;
  let quitting = false;
  async function projects(raw?: unknown): Promise<string[]> {
    parseNoInput(raw);
    try { return parseLearningProjects(await options.projects()); }
    catch { throw new Error("无法读取项目范围，请刷新工作项来源并检查 Provider 配置。"); }
  }

  async function requireProject(scope: string): Promise<void> {
    if (!(await projects()).includes(scope)) throw new Error("该项目不在当前工作项来源中，请重新选择项目。");
  }

  async function mutate(dispatch: Dispatch, action: MutationAction, input: LearningQuery): Promise<unknown> {
    await requireProject(input.scope);
    return dispatch(action, { ...input });
  }

  async function scoped<Result>(scope: string, operation: (dispatch: Dispatch) => Promise<Result>, recoverCompleted?: (result: Result) => Result): Promise<Result> {
    await requireProject(scope);
    let result: Result;
    let completed: { result: Result } | undefined;
    try {
      result = await options.withRuntime(async runtime => {
        const value = await operation((action, input) => runtime.dispatchSystemAction(action, input));
        completed = { result: value };
        return value;
      });
    }
    catch (error) {
      if (completed && recoverCompleted) result = recoverCompleted(completed.result);
      else {
        if (error instanceof SelectionUnavailable) throw new Error("当前项目中找不到该候选，或版本已变化，请刷新列表。");
        throw new Error("学习操作失败，请检查学习配置、候选版本与授权后重试。");
      }
    }
    await requireProject(scope);
    return result;
  }

  async function scopedCandidates(dispatch: Dispatch, scope: string): Promise<DesktopLearningCandidate[]> {
    return candidateProjections(await dispatch("learning.candidates", { scope }), scope);
  }

  async function refreshCandidates(dispatch: Dispatch, scope: string): Promise<DesktopLearningCandidate[] | undefined> {
    let records: unknown;
    try { records = await dispatch("learning.candidates", { scope }); }
    catch { return undefined; }
    return candidateProjections(records, scope);
  }

  function requireCandidate(candidates: readonly DesktopLearningCandidate[], candidateId: LearningCandidate["id"], expectedVersion?: number) {
    const candidate = candidates.find(entry => entry.id === candidateId);
    if (!candidate || (expectedVersion !== undefined && candidate.version !== expectedVersion)) throw new SelectionUnavailable();
    return candidate;
  }

  function requirePublicationVersion(publication: DesktopLearningPublication, candidates: readonly DesktopLearningCandidate[]): void {
    const candidate = requireCandidate(candidates, publication.candidateId);
    if (candidate.version < publication.candidateVersion
      || (publication.phase === "committed" && candidate.version === publication.candidateVersion)) throw new Error();
  }

  return {
    projects,
    async jobs(raw) {
      const input = parseLearningQuery(raw);
      return scoped(input.scope, async dispatch => {
        const records = batch(await dispatch("learning.jobs", { ...input }));
        const jobs = [];
        for (const value of records) {
          const job = parseObject(value, "job");
          if (typeof job.scope !== "string") throw new Error();
          if (job.scope !== input.scope) continue;
          jobs.push(projectLearningJob(job));
          if (jobs.length === LEARNING_LIMITS.records) break;
        }
        return parseLearningJobs(jobs);
      });
    },
    worker: {
      async once(raw) {
        const input = parseLearningWorkerTarget(raw);
        const launch = options.launchWorker;
        if (quitting || !launch) throw new Error("学习 Worker 不可用。");
        if (activeWorker) throw new Error("桌面端已有学习 Worker 正在运行。");
        const controller = new AbortController();
        const { signal } = controller;
        const done = (async (): Promise<DesktopLearningWorkerResult> => {
          try {
            const canRun = await scoped(input.scope, async dispatch => {
              const state = parseObject(await dispatch("learning.request", input), "selected request");
              const job = projectLearningJob(state.job);
              return job.scope === input.scope && job.jobId === input.requestKey && job.canRun;
            });
            if (!canRun) throw new Error("当前项目中没有可运行的对应任务，请刷新列表。");
            signal.throwIfAborted();
          } catch (error) {
            if (signal.aborted) return { status: "cancelled" };
            throw error;
          }
          try {
            const result = parseLearningWorkerResult(await launch(input, signal));
            if (signal.aborted) return { status: "cancelled" };
            if (result.status !== "finished" || result.job.scope !== input.scope || result.job.jobId !== input.requestKey) throw new Error();
            await requireProject(input.scope);
            return signal.aborted ? { status: "cancelled" } : result;
          } catch {
            if (signal.aborted) return { status: "cancelled" };
            throw new Error("学习 Worker 未完成，请检查已保存的学习配置与运行状态。");
          }
        })();
        activeWorker = { target: input, controller, done };
        try { return await done; }
        finally { activeWorker = undefined; }
      },
      async cancel(raw) {
        const input = parseLearningWorkerTarget(raw);
        const worker = activeWorker;
        if (!worker || worker.target.scope !== input.scope || worker.target.requestKey !== input.requestKey) return false;
        await requireProject(input.scope);
        if (worker !== activeWorker) return false;
        worker.controller.abort();
        return true;
      },
    },
    stopWorker() {
      quitting = true;
      const worker = activeWorker;
      worker?.controller.abort();
      return worker?.done.then(() => {}, () => {});
    },
    async candidates(raw) {
      const input = parseLearningQuery(raw);
      return scoped(input.scope, async dispatch => parseLearningCandidates((await scopedCandidates(dispatch, input.scope)).slice(0, LEARNING_LIMITS.records)));
    },
    async correct(raw) {
      const input = parseLearningCorrectionInput(raw);
      return scoped(input.scope, async dispatch => {
        requireCandidate(await scopedCandidates(dispatch, input.scope), input.candidateId, input.expectedVersion);
        const response = await mutate(dispatch, "learning.correct", input);
        const result = parseLearningCorrectionResult(response);
        assertExactKeys(response as Record<string, unknown>, ["jobId", "scope", "candidateId", "candidateVersion"], "correction");
        if (result.scope !== input.scope || result.candidateId !== input.candidateId || result.candidateVersion !== input.expectedVersion) throw new Error();
        let refreshed = false;
        try { refreshed = requireCandidate(await scopedCandidates(dispatch, input.scope), input.candidateId).version >= result.candidateVersion; }
        catch { refreshed = false; }
        await requireProject(input.scope);
        return refreshed ? result : { ...result, candidateRefresh: "unavailable" as const };
      }, result => ({ ...result, candidateRefresh: "unavailable" as const }));
    },
    async validate(raw) {
      const input = parseLearningValidate(raw);
      return scoped(input.scope, async dispatch => {
        requireCandidate(await scopedCandidates(dispatch, input.scope), input.candidateId, input.expectedVersion);
        const result = parseObject(await mutate(dispatch, "learning.validate", input), "validation");
        assertExactKeys(result, result.status === "validated" ? ["status", "candidateId", "candidateVersion", "validatedVersion", "executionId", "receiptDigest"] : ["status", "code"], "validation");
        const dto = parseLearningValidationResult(result.status === "validated" ? { status: result.status, candidateId: result.candidateId,
          candidateVersion: result.candidateVersion, validatedVersion: result.validatedVersion } : result);
        if (dto.status === "validated" && (dto.candidateId !== input.candidateId || dto.candidateVersion !== input.expectedVersion)) throw new Error();
        const candidate = requireCandidate(await scopedCandidates(dispatch, input.scope), input.candidateId, dto.status === "validated" ? dto.validatedVersion : undefined);
        if (dto.status === "validated" && candidate.state !== "validated") throw new Error();
        return dto;
      });
    },
    knowledge: {
      async prepare(raw) {
        const input = parseKnowledgePrepare(raw);
        return scoped(input.scope, async dispatch => {
          const before = await scopedCandidates(dispatch, input.scope);
          const candidate = requireCandidate(before, input.candidateId, input.expectedVersion);
          const publication = publicationProjection(await mutate(dispatch, "learning.knowledge.prepare", input), input.scope, before);
          const targetRef = input.targetRef ?? candidate.targetRef;
          if (publication.candidateId !== input.candidateId || publication.candidateVersion !== input.expectedVersion
            || (targetRef !== undefined && publication.targetRef !== targetRef) || !["prepared", "applied"].includes(publication.phase)) throw new Error();
          requireCandidate(await scopedCandidates(dispatch, input.scope), input.candidateId, input.expectedVersion);
          return publication;
        });
      },
      async publish(raw) {
        const input = parseKnowledgePublish(raw);
        return scoped(input.scope, async dispatch => {
          const before = await scopedCandidates(dispatch, input.scope);
          const result = resultProjection(await mutate(dispatch, "learning.knowledge.publish", input), input.scope, before);
          const after = await refreshCandidates(dispatch, input.scope);
          if (!after) return { ...result, candidateRefresh: "unavailable" as const };
          requirePublicationVersion(result.publication, after);
          return result;
        });
      },
      async reconcile(raw) {
        const input = parseLearningQuery(raw);
        return scoped(input.scope, async dispatch => {
          const before = await scopedCandidates(dispatch, input.scope);
          const response = parseObject(await mutate(dispatch, "learning.knowledge.reconcile", input), "reconciliation");
          const after = await refreshCandidates(dispatch, input.scope);
          const results = [];
          for (const value of batch(response.results)) {
            const publication = parseObject(parseObject(value, "result").publication, "publication");
            if (!before.some(candidate => candidate.id === publication.candidateId)
              || (after && !after.some(candidate => candidate.id === publication.candidateId))) continue;
            const result = resultProjection(value, input.scope, before);
            if (after) requirePublicationVersion(result.publication, after);
            results.push(result);
            if (results.length === LEARNING_LIMITS.records) break;
          }
          const blocked = batch(response.blocked).slice(0, LEARNING_LIMITS.records).map(value => ({ code: parseObject(value, "blocked").code }));
          return parseLearningReconciliation({ results, blocked, ...(!after ? { candidateRefresh: "unavailable" } : {}) });
        });
      },
    },
  };
}
