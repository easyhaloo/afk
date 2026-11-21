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
const correctionInput = { ...selection, correction: "  SECRET correction\nwith details  " };
const correctionReceipt = { jobId: key, scope, candidateId, candidateVersion: 2 };
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
  const job: LearningJob = { jobId: requestKey, scope, status: "blocked", canRun: false, sourceId: "SECRET /private/source", reasonCode: "SECRET",
    attempts: [{ requestKey, callId: "SECRET", day: "2026-11-11", startedAt: "2026-11-11T00:00:00Z", ownerPid: 123, host: "SECRET", status: "started" }] };
  const publication = { key, candidateId, candidateVersion: 3, targetRef: "wiki:approval", phase: "prepared",
    validatorVersion: "SECRET", candidateDigest: "d".repeat(64), evidenceDigest: "e".repeat(64),
    originalDigest: "1".repeat(64), targetDigest: "2".repeat(64), recoveryRef: "SECRET /private/recovery" };
  const projects = vi.fn(async () => [scope, other]);
  const dispatchSystemAction = vi.fn(async (action: string, _input: unknown): Promise<unknown> => {
    if (action === "learning.jobs") return [job, { ...job, scope: other, jobId: foreignId }];
    if (action === "learning.candidates") return rows;
    if (action === "learning.correct") return correctionReceipt;
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
  it("holds its worker slot through cancellation cleanup and shuts down only its own worker", async () => {
    const data = fixture();
    const target = { scope, requestKey };
    const job = { ...data.job, status: "pending", canRun: true, attempts: [] };
    const dispatchSystemAction = vi.fn(async () => ({ job }));
    let cleanup!: () => void;
    let launched!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>(resolve => { launched = resolve; });
    const launchWorker = vi.fn(async (_target, signal) => {
      launched(signal);
      return new Promise(resolve => { cleanup = () => resolve({ status: "cancelled" }); });
    });
    const service = createLearningService({ projects: data.projects, withRuntime: action => action({ dispatchSystemAction }), launchWorker });

    const result = service.worker.once(target);
    const signal = await started;
    expect(await service.worker.cancel({ ...target, scope: other })).toBe(false);
    expect(signal.aborted).toBe(false);
    await expect(service.worker.once(target)).rejects.toThrow("正在运行");
    const stopping = service.stopWorker();
    expect(signal.aborted).toBe(true);
    let stopped = false;
    void stopping!.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    cleanup();
    await expect(result).resolves.toEqual({ status: "cancelled" });
    await stopping;
    await expect(service.worker.once(target)).rejects.toThrow("不可用");
    expect(launchWorker).toHaveBeenCalledTimes(1);
  });

  it("submits only a correction action and returns the bound receipt without changing the candidate", async () => {
    const data = fixture();
    const before = structuredClone(data.rows);
    expect(await data.service.correct(correctionInput)).toEqual(correctionReceipt);
    expect(data.dispatchSystemAction.mock.calls).toEqual([
      ["learning.candidates", { scope }], ["learning.correct", correctionInput], ["learning.candidates", { scope }],
    ]);
    expect(data.rows).toEqual(before);
    expect(JSON.stringify(await data.service.correct(correctionInput))).not.toContain("SECRET");
  });

  it.each(["x".repeat(32768), "界".repeat(10922) + "ab"])("dispatches a raw correction at the UTF-8 limit, case %#", async correction => {
    const { service, dispatchSystemAction } = fixture();
    expect(await service.correct({ ...selection, correction })).toEqual(correctionReceipt);
    expect(dispatchSystemAction).toHaveBeenCalledWith("learning.correct", { ...selection, correction });
  });

  it("accepts the maximum safe version without requiring a successor version", async () => {
    const data = fixture();
    data.rows = [{ ...candidate(), version: Number.MAX_SAFE_INTEGER }];
    data.dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? data.rows
      : { ...correctionReceipt, candidateVersion: Number.MAX_SAFE_INTEGER });
    expect(await data.service.correct({ ...correctionInput, expectedVersion: Number.MAX_SAFE_INTEGER }))
      .toEqual({ ...correctionReceipt, candidateVersion: Number.MAX_SAFE_INTEGER });
  });

  it("rejects inventory revocation during lease release after a valid correction postflight", async () => {
    const data = fixture();
    const service = createLearningService({ projects: data.projects, withRuntime: async operation => {
      try { return await operation({ dispatchSystemAction: data.dispatchSystemAction }); }
      finally { data.projects.mockResolvedValue([]); }
    } });
    await expect(service.correct(correctionInput)).rejects.toThrow("不在当前工作项来源");
    expect(data.dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(["learning.candidates", "learning.correct", "learning.candidates"]);
  });

  it("rejects malformed input before inventory lookup or acquiring a runtime", async () => {
    const data = fixture();
    let acquired = 0;
    const service = createLearningService({ projects: data.projects, withRuntime: operation => {
      acquired++;
      return operation({ dispatchSystemAction: data.dispatchSystemAction });
    } });
    for (const change of [{ correction: "" }, { correction: " \n\t" }, { correction: "SECRET\0" },
      { correction: "x".repeat(32769) }, { correction: "界".repeat(10923) }, { correction: " ".repeat(32768) + "x" },
      { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { scope: "github:acme/api " }, { candidateId: "A".repeat(64) }, { command: "SECRET" }]) {
      await expect(service.correct({ ...correctionInput, ...change } as never)).rejects.toThrow(/^学习数据无效，请刷新后重试。$/);
    }
    expect(acquired).toBe(0);
    expect(data.projects).not.toHaveBeenCalled();
    expect(data.dispatchSystemAction).not.toHaveBeenCalled();
  });

  it("rejects unknown projects before acquiring a runtime", async () => {
    const data = fixture();
    let acquired = 0;
    const service = createLearningService({ projects: data.projects, withRuntime: operation => {
      acquired++;
      return operation({ dispatchSystemAction: data.dispatchSystemAction });
    } });
    await expect(service.correct({ ...correctionInput, scope: "github:unknown/repo" })).rejects.toThrow("不在当前工作项来源");
    expect(acquired).toBe(0);
    expect(data.dispatchSystemAction).not.toHaveBeenCalled();
  });

  it.each([{ candidateId: foreignId }, { candidateId: "e".repeat(64) }, { expectedVersion: 1 }, { expectedVersion: 3 }])(
    "refuses wrong-scope, missing or stale correction targets, case %#", async change => {
      const { service, dispatchSystemAction } = fixture();
      await expect(service.correct({ ...correctionInput, ...change })).rejects.toThrow("当前项目");
      expect(dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(["learning.candidates"]);
    });

  it.each([false, true])("rechecks permission before dispatch and after submission (submitted: %s)", async submitted => {
    const data = fixture();
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") {
        if (!submitted) data.projects.mockResolvedValue([]);
        return data.rows;
      }
      data.projects.mockResolvedValue([]);
      return correctionReceipt;
    });
    await expect(data.service.correct(correctionInput)).rejects.toThrow();
    expect(data.dispatchSystemAction.mock.calls.filter(([action]) => action === "learning.correct")).toHaveLength(submitted ? 1 : 0);
  });

  it.each([{ scope: other }, { candidateId: foreignId }, { candidateVersion: 1 }, { candidateVersion: 99 },
    { candidateVersion: 0 }, { candidateVersion: Number.MAX_SAFE_INTEGER + 1 }, { jobId: "A".repeat(64) },
    { correction: "SECRET" }, { diagnostics: "SECRET" }, { candidateRefresh: "unavailable" }])(
    "rejects unbound or malformed backend receipts before any degraded refresh, case %#", async change => {
      const data = fixture();
      let submitted = false;
      data.dispatchSystemAction.mockImplementation(async action => {
        if (action === "learning.candidates") {
          if (submitted) throw new Error("SECRET postflight");
          return data.rows;
        }
        submitted = true;
        return { ...correctionReceipt, ...change };
      });
      await expect(data.service.correct(correctionInput)).rejects.toThrow(/^学习操作失败，请检查学习配置、候选版本与授权后重试。$/);
      expect(data.dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(["learning.candidates", "learning.correct"]);
    });

  it.each([false, true])("preserves an accepted receipt on read failure but still rejects revoked projects (%s)", async revoked => {
    const data = fixture();
    let submitted = false;
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") {
        if (submitted) {
          if (revoked) data.projects.mockResolvedValue([]);
          throw new Error("SECRET read failure");
        }
        return data.rows;
      }
      submitted = true;
      return correctionReceipt;
    });
    const pending = data.service.correct(correctionInput);
    if (revoked) await expect(pending).rejects.toThrow();
    else expect(await pending).toEqual({ ...correctionReceipt, candidateRefresh: "unavailable" });
    expect(data.dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(["learning.candidates", "learning.correct", "learning.candidates"]);
  });

  it.each([null, {}, [], [candidate(other)], [{ ...candidate(), version: 1 }], [{ ...candidate(), version: "SECRET" }]])(
    "preserves an accepted receipt for malformed, missing, foreign or regressed postflight targets, case %#", async after => {
      const data = fixture();
      let submitted = false;
      data.dispatchSystemAction.mockImplementation(async action => {
        if (action === "learning.candidates") return submitted ? after : data.rows;
        submitted = true;
        return correctionReceipt;
      });
      expect(await data.service.correct(correctionInput)).toEqual({ ...correctionReceipt, candidateRefresh: "unavailable" });
      expect(data.dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(["learning.candidates", "learning.correct", "learning.candidates"]);
    });

  it("preserves a receipt when a concurrent operation advances the original candidate", async () => {
    const data = fixture();
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") return data.rows;
      data.rows = [{ ...candidate(), version: 3, state: "validated" }];
      return correctionReceipt;
    });
    expect(await data.service.correct(correctionInput)).toEqual(correctionReceipt);
  });

  it.each(["success", "read-outage", "dispatch-error", "receipt-error", "postflight-error", "revoked"])(
    "holds one runtime lease through correction postflight and releases it on %s", async outcome => {
      const data = fixture();
      let leased = false;
      let released = 0;
      let submitted = false;
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      data.dispatchSystemAction.mockImplementation(async action => {
        expect(leased).toBe(true);
        if (action === "learning.candidates") {
          if (submitted) {
            await gate;
            if (outcome === "read-outage") throw new Error("SECRET refresh");
            if (outcome === "postflight-error") return {};
            if (outcome === "revoked") data.projects.mockResolvedValue([]);
          }
          return data.rows;
        }
        submitted = true;
        if (outcome === "dispatch-error") throw new Error("SECRET provider");
        return outcome === "receipt-error" ? { ...correctionReceipt, candidateVersion: 99 } : correctionReceipt;
      });
      const withRuntime = vi.fn();
      const service = createLearningService({ projects: data.projects, withRuntime: async operation => {
        withRuntime();
        leased = true;
        try { return await operation({ dispatchSystemAction: data.dispatchSystemAction }); }
        finally { leased = false; released++; }
      } });
      const pending = service.correct(correctionInput);
      const checked = outcome === "success" || outcome === "read-outage" || outcome === "postflight-error"
        ? expect(pending).resolves.toEqual({ ...correctionReceipt, ...(outcome !== "success" ? { candidateRefresh: "unavailable" } : {}) })
        : expect(pending).rejects.not.toThrow("SECRET");
      if (outcome !== "dispatch-error" && outcome !== "receipt-error") {
        await vi.waitFor(() => expect(data.dispatchSystemAction).toHaveBeenCalledTimes(3));
        expect(leased).toBe(true);
        expect(released).toBe(0);
      }
      finish();
      await checked;
      expect(withRuntime).toHaveBeenCalledTimes(1);
      expect(leased).toBe(false);
      expect(released).toBe(1);
    });

  it.each(["accepted", "read-outage", "revoked", "dispatch-error", "receipt-error"] as const)(
    "awaits failed lease cleanup and recovers only an authorized, validated correction receipt: %s", async outcome => {
      const data = fixture();
      let submitted = false;
      let operationCompleted = false;
      let cleanupCompleted = false;
      let settled = false;
      let enterCleanup!: () => void;
      let finishCleanup!: () => void;
      const cleanupEntered = new Promise<void>(resolve => { enterCleanup = resolve; });
      const cleanupGate = new Promise<void>(resolve => { finishCleanup = resolve; });
      data.dispatchSystemAction.mockImplementation(async action => {
        if (action === "learning.candidates") {
          if (submitted && outcome === "read-outage") throw new Error("SECRET postflight");
          return data.rows;
        }
        submitted = true;
        if (outcome === "dispatch-error") throw new Error("SECRET provider /private/credentials");
        return outcome === "receipt-error" ? { ...correctionReceipt, candidateVersion: 99 } : correctionReceipt;
      });
      const withRuntime = vi.fn();
      const service = createLearningService({ projects: data.projects, withRuntime: async operation => {
        withRuntime();
        try {
          const result = await operation({ dispatchSystemAction: data.dispatchSystemAction });
          operationCompleted = true;
          return result;
        } finally {
          enterCleanup();
          await cleanupGate;
          if (outcome === "revoked") data.projects.mockResolvedValue([]);
          cleanupCompleted = true;
          throw new Error("SECRET lease cleanup /private/credentials");
        }
      } });
      const pending = service.correct(correctionInput);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const checked = outcome === "accepted" || outcome === "read-outage"
        ? expect(pending).resolves.toEqual({ ...correctionReceipt, candidateRefresh: "unavailable" })
        : outcome === "revoked"
          ? expect(pending).rejects.toThrow("不在当前工作项来源")
          : expect(pending).rejects.toThrow(/^学习操作失败，请检查学习配置、候选版本与授权后重试。$/);
      await cleanupEntered;
      expect(operationCompleted).toBe(outcome !== "dispatch-error" && outcome !== "receipt-error");
      expect(cleanupCompleted).toBe(false);
      expect(settled).toBe(false);
      expect(withRuntime).toHaveBeenCalledTimes(1);
      const projectChecksBeforeRelease = data.projects.mock.calls.length;
      finishCleanup();
      await checked;
      expect(cleanupCompleted).toBe(true);
      expect(settled).toBe(true);
      expect(data.dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(
        outcome === "dispatch-error" || outcome === "receipt-error"
          ? ["learning.candidates", "learning.correct"]
          : ["learning.candidates", "learning.correct", "learning.candidates"],
      );
      if (outcome === "accepted" || outcome === "read-outage" || outcome === "revoked") {
        expect(data.projects.mock.calls.length).toBeGreaterThan(projectChecksBeforeRelease);
      }
    });

  it("sanitizes runtime acquisition, dispatch and inventory errors for corrections", async () => {
    const data = fixture();
    const service = createLearningService({ projects: data.projects, withRuntime: async () => { throw new Error("SECRET runtime creation"); } });
    await expect(service.correct(correctionInput)).rejects.toThrow(/^学习操作失败，请检查学习配置、候选版本与授权后重试。$/);
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") return data.rows;
      throw new Error("SECRET provider /private/credentials");
    });
    await expect(data.service.correct(correctionInput)).rejects.toThrow(/^学习操作失败，请检查学习配置、候选版本与授权后重试。$/);
    data.projects.mockRejectedValue(new Error("SECRET inventory"));
    await expect(data.service.correct(correctionInput)).rejects.toThrow(/^无法读取项目范围，请刷新工作项来源并检查 Provider 配置。$/);
  });

  it("queries only existing read actions and projects bounded metadata without secrets", async () => {
    const { service, dispatchSystemAction } = fixture();
    expect(await service.projects()).toEqual([scope, other]);
    expect(await service.jobs({ scope })).toEqual([{ jobId: requestKey, scope, status: "blocked", attemptCount: 1, canRun: false }]);
    const records = await service.candidates({ scope });
    expect(records).toEqual([{ id: candidateId, requestKey, scope, version: 2, state: "candidate", kind: "fact", title: "Approval", evidenceCount: 1, targetRef: "wiki:approval" }]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
    expect(dispatchSystemAction.mock.calls.map(([action]) => action)).toEqual(["learning.jobs", "learning.candidates"]);
    expect(Object.keys(service).sort()).toEqual(["candidates", "correct", "jobs", "knowledge", "projects", "stopWorker", "validate", "worker"]);
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

  it.each([false, true])("preserves a scoped committed successor and its experience projection (blocked: %s)", async blocked => {
    const data = fixture();
    data.rows = [{ ...candidate(), version: 4, state: "published" }];
    const successorKey = "d".repeat(64);
    const experienceProjection = { blocked: blocked ? [successorKey] : [] };
    data.dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? data.rows
      : { publication: { ...data.publication, key: successorKey, phase: "committed" }, experienceProjection });
    const result = await data.service.knowledge.publish({ scope, key });
    expect(result).toEqual({ publication: { key: successorKey, scope, candidateId, candidateVersion: 3,
      targetRef: "wiki:approval", phase: "committed" }, experienceProjection });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([["publish", false], ["reconcile", false], ["publish", true], ["reconcile", true]] as const)(
    "checks inventory revocation=%s/%s when the postflight candidate read fails", async (operation, revoked) => {
    const data = fixture();
    data.rows = [{ ...candidate(), version: 3, state: "validated" }];
    let completed = false;
    const result = { publication: { ...data.publication, phase: "committed" }, experienceProjection: { blocked: [key] } };
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") {
        if (completed) throw new Error("SECRET_CANDIDATE_READ_ERROR");
        return data.rows;
      }
      completed = true;
      if (revoked) data.projects.mockResolvedValue([]);
      return operation === "publish" ? result : { results: [result], blocked: [{ key, code: "experience_projection_blocked" }] };
    });
    const pending = operation === "publish" ? data.service.knowledge.publish({ scope, key })
      : data.service.knowledge.reconcile({ scope });
    if (revoked) {
      await expect(pending).rejects.toThrow("不在当前工作项来源");
      expect(data.dispatchSystemAction.mock.calls.filter(([action]) => action === "learning.candidates")).toHaveLength(2);
      return;
    }
    const response = await pending;
    const projected = { publication: { key, scope, candidateId, candidateVersion: 3, targetRef: "wiki:approval", phase: "committed" },
      experienceProjection: { blocked: [key] } };
    expect(response).toEqual(operation === "publish" ? { ...projected, candidateRefresh: "unavailable" }
      : { results: [projected], blocked: [{ code: "experience_projection_blocked" }], candidateRefresh: "unavailable" });
    expect(JSON.stringify(response)).not.toContain("SECRET");
    expect(data.dispatchSystemAction.mock.calls.filter(([action]) => action === "learning.candidates")).toHaveLength(2);
  });

  it.each(["publish", "reconcile"] as const)("rejects malformed postflight candidates instead of treating %s as a read outage", async operation => {
    const data = fixture();
    data.rows = [{ ...candidate(), version: 3, state: "validated" }];
    let completed = false;
    const result = { publication: { ...data.publication, phase: "committed" } };
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") return completed ? { secret: "SECRET" } : data.rows;
      completed = true;
      return operation === "publish" ? result : { results: [result], blocked: [] };
    });
    const pending = operation === "publish" ? data.service.knowledge.publish({ scope, key })
      : data.service.knowledge.reconcile({ scope });
    await expect(pending).rejects.toThrow("学习操作失败");
  });

  it.each(["publish", "reconcile"] as const)("rejects a future candidate version in %s before accepting unavailable postflight data", async operation => {
    const data = fixture();
    let completed = false;
    const result = { publication: { ...data.publication, candidateVersion: 99, phase: "committed" } };
    data.dispatchSystemAction.mockImplementation(async action => {
      if (action === "learning.candidates") {
        if (completed) throw new Error("SECRET");
        return data.rows;
      }
      completed = true;
      return operation === "publish" ? result : { results: [result], blocked: [] };
    });
    const pending = operation === "publish" ? data.service.knowledge.publish({ scope, key })
      : data.service.knowledge.reconcile({ scope });
    await expect(pending).rejects.toThrow("学习操作失败");
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

  it("preserves committed reconciliation receipts when experience projection needs repair", async () => {
    const data = fixture();
    data.rows = [{ ...candidate(), version: 4, state: "published" }];
    data.dispatchSystemAction.mockImplementation(async action => action === "learning.candidates" ? data.rows
      : { results: [{ publication: { ...data.publication, phase: "committed" } }],
        blocked: [{ key, code: "experience_projection_blocked", recovery: "SECRET /private/experience.sqlite" }] });
    const result = await data.service.knowledge.reconcile({ scope });
    expect(result).toEqual({ results: [{ publication: { key, scope, candidateId, candidateVersion: 3,
      targetRef: "wiki:approval", phase: "committed" } }], blocked: [{ code: "experience_projection_blocked" }] });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(data.dispatchSystemAction).toHaveBeenCalledWith("learning.knowledge.reconcile", { scope });
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
