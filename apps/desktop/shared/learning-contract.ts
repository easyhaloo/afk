import { isWorkItemProjectKey } from "@afk/core";
import type { LearningCandidate, LearningJob, LearningValidationResult, prepareConfiguredKnowledge, publishConfiguredKnowledge } from "@afk/runtime/execution";
import { assertExactKeys, parseObject, parseRequiredString } from "./validation.js";

type RuntimePublication = Awaited<ReturnType<typeof prepareConfiguredKnowledge>>;
type RuntimePublicationResult = Awaited<ReturnType<typeof publishConfiguredKnowledge>>;
type Validated = Extract<LearningValidationResult, { status: "validated" }>;
export type LearningQuery = { scope: string };
export type LearningSelection = LearningQuery & { candidateId: string; expectedVersion: number };
export type LearningValidateInput = LearningSelection & { checkerId: string };
export type KnowledgePrepareInput = LearningSelection & { targetRef?: string };
export type KnowledgePublishInput = LearningQuery & { key: string };
export type DesktopLearningJob = Pick<LearningJob, "jobId" | "scope" | "status"> & { attemptCount: number };
export type DesktopLearningCandidate = Pick<LearningCandidate, "id" | "requestKey" | "version" | "state"> & {
  scope: string; kind: LearningCandidate["proposal"]["kind"]; title: string; evidenceCount: number; targetRef?: string;
};
export type DesktopLearningValidationResult = Extract<LearningValidationResult, { status: "blocked" }>
  | Pick<Validated, "status" | "candidateId" | "candidateVersion" | "validatedVersion">;
export type DesktopLearningPublication = Pick<RuntimePublication, "key" | "candidateId" | "candidateVersion" | "targetRef" | "phase" | "supersededBy"> & { scope: string };
export type DesktopLearningPublicationResult = { publication: DesktopLearningPublication; wikiStatus?: RuntimePublicationResult["wikiStatus"];
  errorCode?: number; withdrawal?: { status: NonNullable<RuntimePublicationResult["withdrawal"]>["status"] } };
export type DesktopLearningReconciliation = { results: DesktopLearningPublicationResult[]; blocked: { code: typeof BLOCKED_CODES[number] }[] };
export type DesktopLearningApi = {
  projects(): Promise<string[]>;
  jobs(input: LearningQuery): Promise<DesktopLearningJob[]>;
  candidates(input: LearningQuery): Promise<DesktopLearningCandidate[]>;
  validate(input: LearningValidateInput): Promise<DesktopLearningValidationResult>;
  knowledge: {
    prepare(input: KnowledgePrepareInput): Promise<DesktopLearningPublication>;
    publish(input: KnowledgePublishInput): Promise<DesktopLearningPublicationResult>;
    reconcile(input: LearningQuery): Promise<DesktopLearningReconciliation>;
  };
};

export const LEARNING_LIMITS = { records: 100, backendRecords: 2000, projects: 2000, bytes: 256 * 1024 } as const;
const STATES = ["candidate", "conflict", "validated", "published", "rejected", "superseded", "revoked"] as const;
const KINDS = ["fact", "process", "lesson", "skill", "tool"] as const satisfies readonly LearningCandidate["proposal"]["kind"][];
const PHASES = ["prepared", "applied", "committed", "conflict", "superseded"] as const;
const VALIDATION_CODES = ["invalid_input", "candidate_unavailable", "scope_mismatch", "stale_candidate", "unsupported_kind",
  "evidence_unavailable", "insufficient_evidence", "source_unavailable", "unauthorized", "authorization_changed", "checker_unavailable",
  "checker_changed", "target_mismatch", "verification_failed", "invalid_receipt", "output_limit", "binding_mismatch", "insufficient_coverage",
  "assertion_failed", "cancelled", "timed_out", "storage_failed", "commit_guard_unavailable"] as const satisfies readonly Extract<LearningValidationResult, { status: "blocked" }>["code"][];
const BLOCKED_CODES = ["publication_recovery_blocked", "knowledge_grant_unavailable", "knowledge_target_ambiguous", "knowledge_configuration_unavailable"] as const;

function checked<Result>(operation: () => Result): Result {
  try {
    const result = operation();
    if (new TextEncoder().encode(JSON.stringify(result)).length > LEARNING_LIMITS.bytes) throw new Error();
    return result;
  } catch { throw new Error("学习数据无效，请刷新后重试。"); }
}

function object(value: unknown, keys: readonly string[]) {
  const input = parseObject(value, "学习数据");
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error();
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || descriptor.get || descriptor.set) throw new Error();
  }
  assertExactKeys(input, keys, "学习数据");
  return input;
}

function text(value: unknown, max: number): string {
  const result = parseRequiredString(value, "学习字段");
  if (result.length > max || result.trim() !== result) throw new Error();
  return result;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error();
  return value;
}

function choice<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error();
  return value;
}

function target(value: unknown, wiki = false): string {
  const result = text(value, 512);
  if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result)
    || result.split(/[/:]/).some(part => !part || part === "." || part === "..") || (wiki && !result.startsWith("wiki:"))) throw new Error();
  return result;
}

function list<Result>(value: unknown, parse: (entry: unknown) => Result, maximum: number = LEARNING_LIMITS.records): Result[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || descriptor.get || descriptor.set) throw new Error();
  }
  const result: Result[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error();
    result.push(parse(value[index]));
  }
  return result;
}

export function parseLearningScope(value: unknown): string {
  return checked(() => {
    const scope = text(value, 512);
    const separator = scope.indexOf(":");
    const platform = scope.slice(0, separator);
    const project = scope.slice(separator + 1);
    if (!["github", "gitlab"].includes(platform) || !isWorkItemProjectKey(project)) throw new Error();
    const parts = project.split("/");
    if (platform === "github" && parts.length !== 2) throw new Error();
    if (platform === "gitlab" && parts[0].includes(".") && (parts.length < 2 || parts[0] !== parts[0].toLowerCase() || parts[0] === "gitlab.com")) throw new Error();
    return scope;
  });
}

export function parseLearningQuery(value: unknown): LearningQuery {
  return checked(() => ({ scope: parseLearningScope(object(value, ["scope"]).scope) }));
}

export function parseLearningValidate(value: unknown): LearningValidateInput {
  return checked(() => {
    const input = object(value, ["scope", "candidateId", "expectedVersion", "checkerId"]);
    const checkerId = text(input.checkerId, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(checkerId)) throw new Error();
    return { scope: parseLearningScope(input.scope), candidateId: digest(input.candidateId),
      expectedVersion: integer(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1), checkerId };
  });
}

export function parseKnowledgePrepare(value: unknown): KnowledgePrepareInput {
  return checked(() => {
    const input = object(value, ["scope", "candidateId", "expectedVersion", "targetRef"]);
    return { scope: parseLearningScope(input.scope), candidateId: digest(input.candidateId),
      expectedVersion: integer(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1), ...(input.targetRef === undefined ? {} : { targetRef: target(input.targetRef, true) }) };
  });
}

export function parseKnowledgePublish(value: unknown): KnowledgePublishInput {
  return checked(() => {
    const input = object(value, ["scope", "key"]);
    return { scope: parseLearningScope(input.scope), key: digest(input.key) };
  });
}

export function parseLearningJob(value: unknown): DesktopLearningJob {
  return checked(() => {
    const input = object(value, ["jobId", "scope", "status", "attemptCount"]);
    return { jobId: digest(input.jobId), scope: parseLearningScope(input.scope), status: choice(input.status, ["pending", "blocked", "failed", "processed"]),
      attemptCount: integer(input.attemptCount, 0, LEARNING_LIMITS.backendRecords) };
  });
}

export function parseLearningCandidate(value: unknown): DesktopLearningCandidate {
  return checked(() => {
    const input = object(value, ["id", "requestKey", "scope", "version", "state", "kind", "title", "evidenceCount", "targetRef"]);
    return { id: digest(input.id), requestKey: digest(input.requestKey), scope: parseLearningScope(input.scope), version: integer(input.version, 1),
      state: choice(input.state, STATES), kind: choice(input.kind, KINDS), title: text(input.title, 256), evidenceCount: integer(input.evidenceCount, 1, 64),
      ...(input.targetRef === undefined ? {} : { targetRef: target(input.targetRef) }) };
  });
}

export function parseLearningValidationResult(value: unknown): DesktopLearningValidationResult {
  return checked(() => {
    const status = object(value, ["status", "code", "candidateId", "candidateVersion", "validatedVersion"]).status;
    if (status === "blocked") {
      const input = object(value, ["status", "code"]);
      return { status, code: choice(input.code, VALIDATION_CODES) };
    }
    if (status !== "validated") throw new Error();
    const input = object(value, ["status", "candidateId", "candidateVersion", "validatedVersion"]);
    const candidateVersion = integer(input.candidateVersion, 1, Number.MAX_SAFE_INTEGER - 1);
    const validatedVersion = integer(input.validatedVersion, 1);
    if (validatedVersion !== candidateVersion + 1) throw new Error();
    return { status, candidateId: digest(input.candidateId), candidateVersion, validatedVersion };
  });
}

export function parseLearningPublication(value: unknown): DesktopLearningPublication {
  return checked(() => {
    const input = object(value, ["key", "scope", "candidateId", "candidateVersion", "phase", "targetRef", "supersededBy"]);
    const phase = choice(input.phase, PHASES);
    const supersededBy = input.supersededBy === undefined ? undefined : digest(input.supersededBy);
    if ((phase === "superseded") !== (supersededBy !== undefined) || supersededBy === input.key) throw new Error();
    return { key: digest(input.key), scope: parseLearningScope(input.scope), candidateId: digest(input.candidateId), candidateVersion: integer(input.candidateVersion, 1),
      phase, targetRef: target(input.targetRef, true), ...(supersededBy === undefined ? {} : { supersededBy }) };
  });
}

export function parseLearningPublicationResult(value: unknown): DesktopLearningPublicationResult {
  return checked(() => {
    const input = object(value, ["publication", "wikiStatus", "errorCode", "withdrawal"]);
    return { publication: parseLearningPublication(input.publication),
      ...(input.wikiStatus === undefined ? {} : { wikiStatus: choice(input.wikiStatus, ["preview", "applied", "unchanged"]) }),
      ...(input.errorCode === undefined ? {} : { errorCode: integer(input.errorCode, 1, 255) }),
      ...(input.withdrawal === undefined ? {} : { withdrawal: { status: choice(object(input.withdrawal, ["status"]).status, ["withdrawn", "rollback_blocked"]) } }) };
  });
}

export function parseLearningReconciliation(value: unknown): DesktopLearningReconciliation {
  return checked(() => {
    const input = object(value, ["results", "blocked"]);
    return { results: list(input.results, parseLearningPublicationResult),
      blocked: list(input.blocked, entry => ({ code: choice(object(entry, ["code"]).code, BLOCKED_CODES) })) };
  });
}

export function parseLearningProjects(value: unknown): string[] { return checked(() => [...new Set(list(value, parseLearningScope, LEARNING_LIMITS.projects))]); }
export function parseLearningJobs(value: unknown): DesktopLearningJob[] { return checked(() => list(value, parseLearningJob)); }
export function parseLearningCandidates(value: unknown): DesktopLearningCandidate[] { return checked(() => list(value, parseLearningCandidate)); }
