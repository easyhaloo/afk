import { describe, expect, it, vi } from "vitest";
import type { LearningCandidate, LearningJob, LearningValidationResult } from "@afk/runtime/execution";
import { createLearningService } from "../../electron/services/learning-service.js";

vi.mock("@afk/runtime/execution", () => { throw new Error("Desktop learning must not load a runtime"); });

const scope = "github:acme/api";
const other = "github:acme/other";
const candidateId = "a".repeat(64);
const foreignId = "f".repeat(64);
const key = "b".repeat(64);
const requestKey = "c".repeat(64);
const selection = { scope, candidateId, expectedVersion: 2 };
const validated: LearningValidationResult = { status: "validated", candidateId, candidateVersion: 2, validatedVersion: 3,
  executionId: "11111111-1111-4111-8111-111111111111", receiptDigest: "d".repeat(64) };

function candidate(project = scope, id = candidateId): LearningCandidate {
  return { id, requestKey, version: 2, state: "candidate", digest: "d".repeat(64), evidenceDigest: "e".repeat(64),
    proposal: { kind: "fact", title: "Approval", statement: "SECRET raw statement /private/evidence", targetRef: "wiki:approval",
      evidenceIds: ["SECRET evidence"], applicability: { project, versions: ["abc"], environments: [], preconditions: [], exclusions: [], invalidationConditions: [] },
      payload: { subject: "SECRET", rule: "SECRET", classification: "fact" } } };
}

function fixture() {
  let rows = [candidate(), candidate(other, foreignId)];
  const job: LearningJob = { jobId: requestKey, scope, status: "blocked", sourceId: "SECRET /private/source", reasonCode: "SECRET",
    attempts: [{ requestKey, callId: "SECRET", day: "2026-11-11", startedAt: "2026-11-11T00:00:00Z", ownerPid: 123, host: "SECRET", status: "started" }] };
  const publication = { key, candidateId, candidateVersion: 3, targetRef: "wiki:approval", phase: "prepared",
    validatorVersion: "SECRET", candidateDigest: "d".repeat(64), evidenceDigest: "e".repeat(64),
    originalDigest: "1".repeat(64), targetDigest: "2".repeat(64), recoveryRef: "SECRET /private/recovery" };
  const projects = vi.fn(async () => [scope, other]);
  const dispatchSystemAction = vi.fn(async (action: string, _input: unknown): Promise<unknown> => {
    if (action === "learning.jobs") return [job, { ...job, scope: other, jobId: foreignId }];
    if (action === "learning.candidates") return rows;
    if (action === "learning.validate") { rows = rows.map(row => row.id === candidateId ? { ...row, version: 3, state: "validated" } : row); return validated; }
    if (action === "learning.knowledge.prepare") return publication;
    if (action === "learning.knowledge.publish") {
      rows = rows.map(row => row.id === candidateId ? { ...row, version: 4, state: "published" } : row);
      return { publication: { ...publication, phase: "committed" }, wikiStatus: "applied", recovery: "SECRET", withdrawal: { status: "withdrawn", reason: "SECRET", recovery: "SECRET" } };
    }
    if (action === "learning.knowledge.reconcile") return { results: [{ publication }], blocked: [{ key: foreignId, code: "publication_recovery_blocked" }] };
    throw new Error("Unexpected action");
  });
  return { projects, dispatchSystemAction, publication, job, get rows() { return rows; }, set rows(value) { rows = value; },
    service: createLearningService({ projects, withRuntime: operation => operation({ dispatchSystemAction }) }) };
}

describe("desktop learning service", () => {
  it("queries only existing read actions and projects bounded metadata without secrets", async () => {
    const { service, dispatchSystemAction } = fixture();
    expect(await service.projects()).toEqual([scope, other]);
    expect(await service.jobs({ scope })).toEqual([{ jobId: requestKey, scope, status: "blocked", attemptCount: 1 }]);
    const records = await service.candidates({ scope });
    expect(records).toEqual([{ id: candidateId, requestKey, scope, version: 2, state: "candidate", kind: "fact", title: "Approval", evidenceCount: 1, targetRef: "wiki:approval" }]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
    expect(dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(["learning.jobs", "learning.candidates"]);
    expect(Object.keys(service).sort()).toEqual(["candidates", "jobs", "knowledge", "projects", "validate"]);
    expect(Object.keys(service.knowledge).sort()).toEqual(["prepare", "publish", "reconcile"]);
  });

  it("dispatches validation and publication only on explicit calls with exact fixed inputs", async () => {
    const { service, dispatchSystemAction } = fixture();
    expect(await service.validate({ ...selection, checkerId: "verify.approval" }))
      .toEqual({ status: "validated", candidateId, candidateVersion: 2, validatedVersion: 3 });
    const prepared = await service.knowledge.prepare({ ...selection, expectedVersion: 3, targetRef: "wiki:approval" });
    expect(prepared).toEqual({ key, scope, candidateId, candidateVersion: 3, targetRef: "wiki:approval", phase: "prepared" });
    const published = await service.knowledge.publish({ scope, key });
    expect(published).toEqual({ publication: { ...prepared, phase: "committed" }, wikiStatus: "applied", withdrawal: { status: "withdrawn" } });
    expect(dispatchSystemAction).toHaveBeenCalledWith("learning.validate", { ...selection, checkerId: "verify.approval" });
    expect(dispatchSystemAction).toHaveBeenCalledWith("learning.knowledge.prepare", { ...selection, expectedVersion: 3, targetRef: "wiki:approval" });
    expect(dispatchSystemAction).toHaveBeenCalledWith("learning.knowledge.publish", { scope, key });
    expect(JSON.stringify(published)).not.toContain("SECRET");
  });

  it("does not dispatch for unknown projects, wrong-scope candidates, stale versions or injected fields", async () => {
    const { service, dispatchSystemAction } = fixture();
    await expect(service.jobs({ scope: "github:unknown/repo" })).rejects.toThrow("不在当前工作项来源");
    expect(dispatchSystemAction).not.toHaveBeenCalled();
    await expect(service.validate({ ...selection, candidateId: foreignId, checkerId: "verify" })).rejects.toThrow("当前项目");
    await expect(service.knowledge.prepare({ ...selection, expectedVersion: 1 })).rejects.toThrow("当前项目");
    await expect(service.validate({ ...selection, checkerId: "verify", passed: true } as never)).rejects.toThrow();
    expect(dispatchSystemAction.mock.calls.every(([action]) => action === "learning.candidates")).toBe(true);
  });

  it.each(["validated-id", "validated-before", "validated-after", "blocked-code", "passed"])("rejects malformed validation result %s", async mismatch => {
    const { service, dispatchSystemAction } = fixture();
    const response = mismatch === "blocked-code" ? { status: "blocked", code: "SECRET /private" }
      : { ...validated, ...(mismatch === "validated-id" ? { candidateId: foreignId } : mismatch === "validated-before" ? { candidateVersion: 1 }
        : mismatch === "validated-after" ? { validatedVersion: 99 } : { passed: true }) };
    dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? [candidate()] : response);
    await expect(service.validate({ ...selection, checkerId: "verify" })).rejects.toThrow("学习操作失败");
  });

  it.each(["insufficient_evidence", "qa_unconfigured", "qa_not_independent", "audit_unavailable", "audit_changed", "qa_unverified"] as const)("preserves blocked validation code %s without fabricating success", async code => {
    const { service, dispatchSystemAction } = fixture();
    dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? [candidate()] : { status: "blocked", code });
    expect(await service.validate({ ...selection, checkerId: "verify" })).toEqual({ status: "blocked", code });
  });

  it("refuses late scope drift after an async validation result", async () => {
    const data = fixture();
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") return data.rows;
      data.rows = [candidate(other)];
      return validated;
    });
    await expect(data.service.validate({ ...selection, checkerId: "verify" })).rejects.toThrow("当前项目");
  });

  it.each(["prepare", "publish"] as const)("refuses a late wrong-scope %s result", async operation => {
    const data = fixture();
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") return data.rows;
      data.rows = [candidate(other)];
      const publication = { ...data.publication, candidateVersion: 2 };
      return operation === "prepare" ? publication : { publication };
    });
    const pending = operation === "prepare" ? data.service.knowledge.prepare(selection) : data.service.knowledge.publish({ scope, key });
    await expect(pending).rejects.toThrow("当前项目");
  });

  it("omits reconciliation records that leave the scope while the action awaits", async () => {
    const data = fixture();
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") return data.rows;
      data.rows = [candidate(other)];
      return { results: [{ publication: data.publication }], blocked: [] };
    });
    expect(await data.service.knowledge.reconcile({ scope })).toEqual({ results: [], blocked: [] });
  });

  it("accepts a scoped successor publication key instead of demanding the superseded input key", async () => {
    const data = fixture();
    data.rows = [{ ...candidate(), version: 4, state: "published" }];
    const successorKey = "d".repeat(64);
    data.dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? data.rows
      : { publication: { ...data.publication, key: successorKey, phase: "committed" } });
    expect((await data.service.knowledge.publish({ scope, key })).publication.key).toBe(successorKey);
  });

  it("rechecks inventory after awaiting a backend response", async () => {
    const { service, projects, dispatchSystemAction } = fixture();
    dispatchSystemAction.mockImplementation(async () => { projects.mockResolvedValue([]); return []; });
    await expect(service.jobs({ scope })).rejects.toThrow("不在当前工作项来源");
  });

  it.each(["validate", "prepare", "publish", "reconcile"] as const)("does not start %s when inventory permission disappears during preflight", async operation => {
    const { service, projects, dispatchSystemAction, publication } = fixture();
    dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") { projects.mockResolvedValue([]); return [candidate()]; }
      if (action === "learning.validate") return validated;
      if (action === "learning.knowledge.prepare") return { ...publication, candidateVersion: 2 };
      if (action === "learning.knowledge.publish") return { publication };
      return { results: [], blocked: [] };
    });
    const pending = operation === "validate" ? service.validate({ ...selection, checkerId: "verify" })
      : operation === "prepare" ? service.knowledge.prepare(selection)
      : operation === "publish" ? service.knowledge.publish({ scope, key }) : service.knowledge.reconcile({ scope });
    await expect(pending).rejects.toThrow();
    expect(dispatchSystemAction.mock.calls.every(([action]) => action === "learning.candidates")).toBe(true);
  });

  it.each(["target", "phase"] as const)("refuses a prepare result with an unexpected %s", async mismatch => {
    const { service, dispatchSystemAction, publication } = fixture();
    dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? [candidate()] : {
      ...publication, candidateVersion: 2, ...(mismatch === "target" ? { targetRef: "wiki:other" } : { phase: "committed" }),
    });
    await expect(service.knowledge.prepare(selection)).rejects.toThrow("学习操作失败");
  });

  it("keeps concurrent scoped queries separate even when they finish out of order", async () => {
    const { service, dispatchSystemAction, job } = fixture();
    let finish!: (value: unknown) => void;
    dispatchSystemAction.mockImplementation(async (_action, input) => (input as { scope: string }).scope === scope
      ? new Promise(resolve => { finish = resolve; }) : [{ ...job, scope: other, jobId: foreignId }]);
    const first = service.jobs({ scope });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await service.jobs({ scope: other }))[0].jobId).toBe(foreignId);
    finish([job, { ...job, scope: other, jobId: foreignId }]);
    expect((await first).map(record => record.jobId)).toEqual([requestKey]);
  });

  it("keeps query scope stable if the dispatcher mutates its input object", async () => {
    const { service, dispatchSystemAction, job } = fixture();
    dispatchSystemAction.mockImplementation(async (_action, input) => {
      (input as { scope: string }).scope = other;
      return [{ ...job, scope: other, jobId: foreignId }];
    });
    expect(await service.jobs({ scope })).toEqual([]);
  });

  it("binds validation to the caller identity even if the dispatcher mutates its request", async () => {
    const { service, dispatchSystemAction } = fixture();
    dispatchSystemAction.mockImplementation(async (action, input) => {
      if (action === "learning.candidates") return [candidate(), { ...candidate(other, foreignId), state: "validated", version: 3 }];
      Object.assign(input as object, { scope: other, candidateId: foreignId });
      return { ...validated, candidateId: foreignId };
    });
    await expect(service.validate({ ...selection, checkerId: "verify" })).rejects.toThrow("学习操作失败");
  });

  it("filters reconciled publications by current scope and omits blocked keys, paths and grant indexes", async () => {
    const { service, dispatchSystemAction, publication } = fixture();
    dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? [candidate(), candidate(other, foreignId)]
      : { results: [{ publication: { ...publication, candidateVersion: 2 } }, { publication: { ...publication, candidateId: foreignId, key: foreignId } }],
        blocked: [{ key: foreignId, code: "publication_recovery_blocked", recovery: "SECRET" }, { grantIndex: 1, code: "knowledge_grant_unavailable" }] });
    const result = await service.knowledge.reconcile({ scope });
    expect(result.results).toHaveLength(1);
    expect(result.blocked).toEqual([{ code: "publication_recovery_blocked" }, { code: "knowledge_grant_unavailable" }]);
    expect(JSON.stringify(result)).not.toContain(foreignId);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each(["publish", "reconcile"] as const)("rejects %s metadata newer than the scoped candidate", async operation => {
    const { service, dispatchSystemAction, publication } = fixture();
    dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? [candidate()]
      : operation === "publish" ? { publication } : { results: [{ publication }], blocked: [] });
    const pending = operation === "publish" ? service.knowledge.publish({ scope, key }) : service.knowledge.reconcile({ scope });
    await expect(pending).rejects.toThrow("学习操作失败");
  });

  it.each(["publish", "reconcile"] as const)("rejects %s committed metadata without an advanced candidate version", async operation => {
    const { service, dispatchSystemAction, publication } = fixture();
    const result = { publication: { ...publication, candidateVersion: 2, phase: "committed" } };
    dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? [candidate()]
      : operation === "publish" ? result : { results: [result], blocked: [] });
    const pending = operation === "publish" ? service.knowledge.publish({ scope, key }) : service.knowledge.reconcile({ scope });
    await expect(pending).rejects.toThrow("学习操作失败");
  });

  it("rejects foreign publication results and mismatched prepare identities", async () => {
    const { service, dispatchSystemAction, publication } = fixture();
    dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? [candidate(), candidate(other, foreignId)]
      : action === "learning.knowledge.publish" ? { publication: { ...publication, candidateId: foreignId } } : { ...publication, candidateVersion: 99 });
    await expect(service.knowledge.publish({ scope, key })).rejects.toThrow("学习操作失败");
    await expect(service.knowledge.prepare(selection)).rejects.toThrow("学习操作失败");
  });

  it("bounds inventories and backend batches, and limits visible rows", async () => {
    const { service, dispatchSystemAction, projects, job } = fixture();
    dispatchSystemAction.mockResolvedValue(Array.from({ length: 101 }, () => job));
    expect(await service.jobs({ scope })).toHaveLength(100);
    dispatchSystemAction.mockResolvedValue(Array.from({ length: 2001 }, () => job));
    await expect(service.jobs({ scope })).rejects.toThrow("学习操作失败");
    projects.mockResolvedValue(Array.from({ length: 2001 }, () => scope));
    await expect(service.projects()).rejects.toThrow("Provider 配置");
  });

  it("returns only fixed sanitized errors for discovery, backend and parsing exceptions", async () => {
    const { service, projects, dispatchSystemAction } = fixture();
    dispatchSystemAction.mockRejectedValue(new Error("SECRET /private/credentials token=abc"));
    await expect(service.jobs({ scope })).rejects.toThrow(/^学习操作失败，请检查学习配置、候选版本与授权后重试。$/);
    projects.mockRejectedValue(new Error("SECRET Provider token"));
    await expect(service.projects()).rejects.toThrow(/^无法读取项目范围，请刷新工作项来源并检查 Provider 配置。$/);
    await expect(service.jobs({ scope, SECRET: true } as never)).rejects.not.toThrow("SECRET");
  });
});
