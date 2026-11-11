import { describe, expect, it } from "vitest";
import {
  parseLearningScope, parseLearningQuery, parseLearningValidate, parseKnowledgePrepare, parseKnowledgePublish,
  parseLearningCandidate, parseLearningJob, parseLearningValidationResult, parseLearningPublication,
  parseLearningPublicationResult, parseLearningReconciliation, parseLearningCandidates,
} from "../shared/learning-contract.js";

const scope = "github:acme/api";
const candidateId = "a".repeat(64);
const key = "b".repeat(64);
const candidate = { id: candidateId, requestKey: key, scope, version: 2, state: "candidate", kind: "fact", title: "Approval", evidenceCount: 1 };
const publication = { key, scope, candidateId, candidateVersion: 3, phase: "prepared", targetRef: "wiki:approval" };

describe("desktop learning wire contract", () => {
  it("accepts canonical project scopes and fixed object requests", () => {
    for (const value of [scope, "gitlab:group/sub/repo", "gitlab:git.example:8443/group/repo"]) expect(parseLearningScope(value)).toBe(value);
    expect(parseLearningQuery({ scope })).toEqual({ scope });
    expect(parseLearningValidate({ scope, candidateId, expectedVersion: 2, checkerId: "verify.approval" }))
      .toEqual({ scope, candidateId, expectedVersion: 2, checkerId: "verify.approval" });
    expect(parseKnowledgePrepare({ scope, candidateId, expectedVersion: 3, targetRef: "wiki:approval" })).toMatchObject({ targetRef: "wiki:approval" });
    expect(parseKnowledgePublish({ scope, key })).toEqual({ scope, key });
  });

  it.each([" github:acme/api", "github:acme/api ", "github:acme", "github:acme/api/extra", "gitlab:gitlab.com/acme/api", "gitlab:GIT.EXAMPLE/acme/api", "gitlab:git.example", "gitlab:git.example:8443", "github:../api", "github:acme/api#1", "github:acme/api\u0000", "/private/vault"])("rejects noncanonical scope %s", value => {
    expect(() => parseLearningScope(value)).toThrow();
  });

  it.each(["11111111-1111-4111-8111-111111111111", "A".repeat(64), "a".repeat(63), "../candidate"])("keeps candidate identity distinct from experience UUID: %s", value => {
    expect(() => parseLearningValidate({ scope, candidateId: value, expectedVersion: 2, checkerId: "check" })).toThrow();
    expect(() => parseKnowledgePublish({ scope, key: value })).toThrow();
  });

  it.each([0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER, Infinity, NaN])("rejects unsafe expected version %s", expectedVersion => {
    expect(() => parseLearningValidate({ scope, candidateId, expectedVersion, checkerId: "check" })).toThrow();
  });

  it.each(["action", "command", "path", "file", "passed", "signal"])("rejects renderer-supplied %s", field => {
    expect(() => parseLearningQuery({ scope, [field]: "SECRET" })).toThrow();
    expect(() => parseLearningValidate({ scope, candidateId, expectedVersion: 2, checkerId: "check", [field]: true })).toThrow();
    expect(() => parseKnowledgePrepare({ scope, candidateId, expectedVersion: 2, [field]: true })).toThrow();
    expect(() => parseKnowledgePublish({ scope, key, [field]: true })).toThrow();
  });

  it("rejects prototypes, symbols, getters and nonlogical checker/target references", () => {
    for (const value of [Object.create({ scope }), new Date(), { scope, [Symbol("secret")]: true }, Object.defineProperty({}, "scope", { enumerable: true, get() { throw new Error("SECRET"); } })]) {
      expect(() => parseLearningQuery(value)).toThrow("学习数据无效");
    }
    for (const checkerId of ["/private/checker", "../check", "test;exit 0", "check\nnext", "x".repeat(129)]) {
      expect(() => parseLearningValidate({ scope, candidateId, expectedVersion: 2, checkerId })).toThrow();
    }
    for (const targetRef of ["/vault/page.md", "wiki:../escape", "wiki:a/../escape", "https://example.test", "wiki:a//b"]) {
      expect(() => parseKnowledgePrepare({ scope, candidateId, expectedVersion: 2, targetRef })).toThrow();
    }
  });

  it("strictly parses display DTOs and serializes without adding runtime objects", () => {
    expect(parseLearningCandidate(candidate)).toEqual(candidate);
    expect(parseLearningJob({ jobId: key, scope, status: "pending", attemptCount: 0 })).toEqual({ jobId: key, scope, status: "pending", attemptCount: 0 });
    expect(parseLearningPublication(publication)).toEqual(publication);
    const result = parseLearningPublicationResult({ publication, withdrawal: { status: "rollback_blocked" }, errorCode: 4 });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    for (const value of [{ ...candidate, payload: { token: "SECRET" } }, { ...candidate, title: "x".repeat(257) }, { ...candidate, kind: "unknown" }, { ...candidate, version: 0 }]) {
      expect(() => parseLearningCandidate(value)).toThrow();
    }
    expect(() => parseLearningPublication({ ...publication, recoveryRef: "/private/recovery" })).toThrow();
    expect(() => parseLearningPublicationResult({ publication, withdrawal: { status: "withdrawn", reason: "SECRET" } })).toThrow();
  });

  it("preserves the validation discriminant and precise before/after versions", () => {
    expect(parseLearningValidationResult({ status: "validated", candidateId, candidateVersion: 2, validatedVersion: 3 }))
      .toEqual({ status: "validated", candidateId, candidateVersion: 2, validatedVersion: 3 });
    expect(parseLearningValidationResult({ status: "blocked", code: "assertion_failed" })).toEqual({ status: "blocked", code: "assertion_failed" });
    for (const value of [{ status: "blocked", code: "SECRET" }, { status: "blocked", code: "assertion_failed", candidateId },
      { status: "validated", candidateId, candidateVersion: 2, validatedVersion: 2 }, { status: "validated", candidateId, candidateVersion: 2, validatedVersion: 3, passed: true }]) {
      expect(() => parseLearningValidationResult(value)).toThrow();
    }
  });

  it("bounds reconciliation DTOs and refuses raw blocked keys and diagnostic text", () => {
    expect(parseLearningReconciliation({ results: [{ publication }], blocked: [{ code: "knowledge_grant_unavailable" }] }).results).toHaveLength(1);
    expect(() => parseLearningReconciliation({ results: Array.from({ length: 101 }, () => ({ publication })), blocked: [] })).toThrow();
    expect(() => parseLearningReconciliation({ results: [], blocked: [{ code: "publication_recovery_blocked", key }] })).toThrow();
    expect(() => parseLearningReconciliation({ results: [], blocked: [{ code: "SECRET" }] })).toThrow();
  });

  it("bounds aggregate UTF-8 output even when individual fields and row counts fit", () => {
    const large = { ...candidate, scope: "gitlab:" + "界".repeat(505), title: "界".repeat(256), targetRef: "wiki:" + "x".repeat(507) };
    expect(parseLearningCandidate(large)).toEqual(large);
    expect(() => parseLearningCandidates(Array.from({ length: 100 }, () => large))).toThrow();
  });
});
