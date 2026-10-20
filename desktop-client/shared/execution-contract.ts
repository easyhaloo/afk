import { parseWorkItemId, type WorkItemId } from "./backlog-contract.js";
import { assertExactKeys, parseObject, parseRequiredString } from "./validation.js";
import type { RuntimeHealth, WorkflowInstance, WorkflowInstanceStep } from "@afk/application";
export type { RuntimeHealth, WorkflowInstance } from "@afk/application";

export const EXECUTION_STATUSES = [
  "pending", "running", "awaiting_human", "succeeded", "failed", "cancelled",
] as const;
export const EXECUTION_PHASES = ["implementation", "verification", "release"] as const;

export type ExecutionStatus = typeof EXECUTION_STATUSES[number];

export type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type ExecutionSummary = {
  runId: string;
  workItemId: WorkItemId;
  profileId: string;
  attempt: number;
  status: ExecutionStatus;
  phase?: typeof EXECUTION_PHASES[number];
  sequence: number;
  terminal: boolean;
  /** When the run was first recorded, and when its last event was. */
  startedAt?: string;
  updatedAt?: string;
  /** False when the run's event chain is broken. */
  integrityValid: boolean;
  usage?: AgentUsage;
};

export type ExecutionQueryOptions = { workItemId?: WorkItemId; limit?: number; since?: string };

export type ExecutionTimelineEntry = {
  sequence: number;
  occurredAt: string;
  kind: string;
  phase?: typeof EXECUTION_PHASES[number];
  stepId?: string;
  outcome?: "succeeded" | "failed" | "cancelled";
  failureSummary?: string;
  changeId?: string;
  changeUrl?: string;
  commitSha?: string;
  branch?: string;
  workspacePath?: string;
  workspaceBranch?: string;
  reason?: string;
};

export type ExecutionRunDetail = {
  runId: string;
  workItemId: WorkItemId;
  status?: ExecutionStatus;
  phase?: typeof EXECUTION_PHASES[number];
  integrityValid: boolean;
  integrityReason?: string;
  health?: RuntimeHealth;
  workflow?: WorkflowInstance;
  workspacePath?: string;
  workspaceBranch?: string;
  startedAt?: string;
  updatedAt?: string;
  entries: readonly ExecutionTimelineEntry[];
};

export function parseExecutionQueryOptions(input: unknown): ExecutionQueryOptions {
  if (input === undefined) return {};
  const candidate = parseObject(input, "execution query");
  assertExactKeys(candidate, ["workItemId", "limit", "since"], "execution query");
  const options: ExecutionQueryOptions = {};
  if (candidate.workItemId !== undefined) options.workItemId = parseWorkItemId(candidate.workItemId);
  if (candidate.limit !== undefined) {
    if (typeof candidate.limit !== "number" || !Number.isSafeInteger(candidate.limit) || candidate.limit < 1 || candidate.limit > 100) throw new Error("execution query limit is invalid");
    options.limit = candidate.limit;
  }
  if (candidate.since !== undefined) options.since = parseRequiredString(candidate.since, "execution query cursor");
  return options;
}

export function parseExecutionSummary(input: unknown): ExecutionSummary {
  const candidate = parseObject(input, "execution summary");
  assertExactKeys(candidate, ["runId", "workItemId", "profileId", "attempt", "status", "phase", "sequence", "terminal", "startedAt", "updatedAt", "integrityValid", "usage"], "execution summary");
  const workItemId = parseWorkItemId(candidate.workItemId);
  if (!EXECUTION_STATUSES.includes(candidate.status as ExecutionStatus)) throw new Error("execution summary status is invalid");
  if (candidate.phase !== undefined && !EXECUTION_PHASES.includes(candidate.phase as typeof EXECUTION_PHASES[number])) throw new Error("execution summary phase is invalid");
  if (typeof candidate.attempt !== "number" || !Number.isSafeInteger(candidate.attempt) || candidate.attempt < 1) throw new Error("execution summary attempt is invalid");
  if (typeof candidate.sequence !== "number" || !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) throw new Error("execution summary sequence is invalid");
  if (typeof candidate.terminal !== "boolean") throw new Error("execution summary terminal is invalid");
  if (typeof candidate.integrityValid !== "boolean") throw new Error("execution summary integrityValid is invalid");
  const summary: ExecutionSummary = {
    runId: parseRequiredString(candidate.runId, "execution summary: runId"),
    workItemId,
    profileId: parseRequiredString(candidate.profileId, "execution summary: profileId"),
    attempt: candidate.attempt,
    status: candidate.status as ExecutionStatus,
    sequence: candidate.sequence,
    terminal: candidate.terminal,
    integrityValid: candidate.integrityValid,
  };
  if (candidate.phase !== undefined) summary.phase = candidate.phase as typeof EXECUTION_PHASES[number];
  if (candidate.startedAt !== undefined) summary.startedAt = parseRequiredString(candidate.startedAt, "execution summary: startedAt");
  if (candidate.updatedAt !== undefined) summary.updatedAt = parseRequiredString(candidate.updatedAt, "execution summary: updatedAt");
  if (candidate.usage !== undefined) {
    const usage = parseObject(candidate.usage, "execution usage");
    assertExactKeys(usage, ["inputTokens", "outputTokens", "totalTokens"], "execution usage");
    if (![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      || usage.totalTokens !== (usage.inputTokens as number) + (usage.outputTokens as number)) throw new Error("execution usage is invalid");
    summary.usage = { inputTokens: usage.inputTokens as number, outputTokens: usage.outputTokens as number, totalTokens: usage.totalTokens as number };
  }
  return summary;
}

const EXECUTION_TIMELINE_KINDS = [
  "run.requested", "run.started", "run.finished",
  "lease.granted", "workspace.prepared", "workflow.recorded",
  "step.started", "step.completed", "implementation.completed",
  "change.created", "change.merge_verified", "change.published",
  "qa.started", "qa.passed", "qa.failed", "commit.recorded",
  "decision.made", "effect.started", "effect.completed",
  "human_gate.opened", "human_gate.approved",
  "failure.classified", "agent.session_recorded",
] as const;

const TIMELINE_ENTRY_KEYS = [
  "sequence", "occurredAt", "kind", "phase", "stepId", "outcome", "failureSummary",
  "changeId", "changeUrl", "commitSha", "branch", "workspacePath", "workspaceBranch", "reason",
] as const;

function optionalString(candidate: Record<string, unknown>, key: typeof TIMELINE_ENTRY_KEYS[number]): string | undefined {
  const value = candidate[key];
  if (value === undefined) return undefined;
  const parsed = parseRequiredString(value, `execution timeline entry: ${key}`, true);
  return parsed.trim() ? parsed : undefined;
}

export function parseExecutionTimelineEntry(input: unknown): ExecutionTimelineEntry {
  const candidate = parseObject(input, "execution timeline entry");
  assertExactKeys(candidate, TIMELINE_ENTRY_KEYS, "execution timeline entry");
  if (typeof candidate.sequence !== "number" || !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) throw new Error("execution timeline entry sequence is invalid");
  if (typeof candidate.occurredAt !== "string" || !Number.isFinite(Date.parse(candidate.occurredAt))) throw new Error("execution timeline entry occurredAt is invalid");
  if (typeof candidate.kind !== "string" || !(EXECUTION_TIMELINE_KINDS as readonly string[]).includes(candidate.kind)) throw new Error("execution timeline entry kind is invalid");
  if (candidate.phase !== undefined && !EXECUTION_PHASES.includes(candidate.phase as typeof EXECUTION_PHASES[number])) throw new Error("execution timeline entry phase is invalid");
  if (candidate.outcome !== undefined && candidate.outcome !== "succeeded" && candidate.outcome !== "failed" && candidate.outcome !== "cancelled") throw new Error("execution timeline entry outcome is invalid");
  const entry: ExecutionTimelineEntry = {
    sequence: candidate.sequence,
    occurredAt: candidate.occurredAt,
    kind: candidate.kind,
  };
  for (const key of ["phase", "stepId", "outcome", "failureSummary", "changeId", "changeUrl", "commitSha", "branch", "workspacePath", "workspaceBranch", "reason"] as const) {
    const value = optionalString(candidate, key);
    if (value !== undefined) {
      if (key === "phase") entry.phase = value as typeof EXECUTION_PHASES[number];
      else if (key === "outcome") entry.outcome = value as "succeeded" | "failed";
      else entry[key] = value;
    }
  }
  return entry;
}

export function parseExecutionRunDetail(input: unknown): ExecutionRunDetail {
  const candidate = parseObject(input, "execution run detail");
  assertExactKeys(candidate, ["runId", "workItemId", "status", "phase", "integrityValid", "integrityReason", "entries", "health", "workflow", "workspacePath", "workspaceBranch", "startedAt", "updatedAt"], "execution run detail");
  if (typeof candidate.integrityValid !== "boolean") throw new Error("execution run detail integrityValid is invalid");
  if (candidate.status !== undefined && !EXECUTION_STATUSES.includes(candidate.status as ExecutionStatus)) throw new Error("execution run detail status is invalid");
  if (candidate.phase !== undefined && !EXECUTION_PHASES.includes(candidate.phase as typeof EXECUTION_PHASES[number])) throw new Error("execution run detail phase is invalid");
  if (!Array.isArray(candidate.entries)) throw new Error("execution run detail entries is invalid");
  const detail: ExecutionRunDetail = {
    runId: parseRequiredString(candidate.runId, "execution run detail: runId"),
    workItemId: parseWorkItemId(candidate.workItemId),
    status: candidate.status as ExecutionStatus,
    integrityValid: candidate.integrityValid,
    entries: candidate.entries.map(entry => parseExecutionTimelineEntry(entry)),
  };
  if (candidate.phase !== undefined) detail.phase = candidate.phase as typeof EXECUTION_PHASES[number];
  if (candidate.integrityReason !== undefined) detail.integrityReason = parseRequiredString(candidate.integrityReason, "execution run detail: integrityReason", true);
  if (candidate.health !== undefined) detail.health = parseRuntimeHealth(candidate.health);
  if (candidate.workflow !== undefined) detail.workflow = parseWorkflowInstance(candidate.workflow);
  for (const key of ["workspacePath", "workspaceBranch", "startedAt", "updatedAt"] as const) {
    if (candidate[key] !== undefined) detail[key] = parseRequiredString(candidate[key], `execution run detail: ${key}`);
  }
  return detail;
}

export function parseRuntimeHealth(input: unknown): RuntimeHealth {
  const value = parseObject(input, "runtime health");
  assertExactKeys(value, ["state", "observedAt", "reason", "heartbeatAt", "completedAt", "provider", "transport", "executionMode", "runnerPid"], "runtime health");
  if (!["live", "stale", "exited", "unknown"].includes(value.state as string)) throw new Error("runtime health state is invalid");
  const health: RuntimeHealth = { state: value.state as RuntimeHealth["state"], observedAt: parseRequiredString(value.observedAt, "health observedAt"), reason: parseRequiredString(value.reason, "health reason") };
  for (const key of ["heartbeatAt", "completedAt", "provider", "transport"] as const) if (value[key] !== undefined) health[key] = parseRequiredString(value[key], `health ${key}`);
  for (const key of ["observedAt", "heartbeatAt", "completedAt"] as const) if (health[key] !== undefined && !Number.isFinite(Date.parse(health[key]!))) throw new Error(`health ${key} is invalid`);
  if (value.executionMode !== undefined) {
    if (value.executionMode !== "interactive" && value.executionMode !== "batch") throw new Error("health executionMode is invalid");
    health.executionMode = value.executionMode;
  }
  if (value.runnerPid !== undefined) {
    if (typeof value.runnerPid !== "number" || !Number.isSafeInteger(value.runnerPid) || value.runnerPid < 1) throw new Error("health runnerPid is invalid");
    health.runnerPid = value.runnerPid;
  }
  return health;
}

export function parseWorkflowInstance(input: unknown): WorkflowInstance {
  const value = parseObject(input, "workflow instance");
  assertExactKeys(value, ["name", "version", "recordedAt", "steps"], "workflow instance");
  if (value.version !== 1 || !Array.isArray(value.steps) || !Number.isFinite(Date.parse(value.recordedAt as string))) throw new Error("workflow instance is invalid");
  const steps = value.steps.map(inputStep => {
    const step = parseObject(inputStep, "workflow instance step");
    assertExactKeys(step, ["id", "kind", "dependsOn", "provider", "executionMode", "status"], "workflow instance step");
    if ((step.kind !== "agent" && step.kind !== "system") || !Array.isArray(step.dependsOn) || !["pending", "running", "succeeded", "failed", "cancelled"].includes(step.status as string)) throw new Error("workflow instance step is invalid");
    const parsed: WorkflowInstanceStep = { id: parseRequiredString(step.id, "workflow step id"), kind: step.kind, dependsOn: step.dependsOn.map(dependency => parseRequiredString(dependency, "workflow dependency")), status: step.status as WorkflowInstanceStep["status"] };
    if (step.provider !== undefined) parsed.provider = parseRequiredString(step.provider, "workflow provider");
    if (step.executionMode !== undefined) {
      if (step.executionMode !== "interactive" && step.executionMode !== "batch") throw new Error("workflow executionMode is invalid");
      parsed.executionMode = step.executionMode;
    }
    return parsed;
  });
  const identities = new Set(steps.map(step => step.id));
  if (identities.size !== steps.length || steps.some(step => step.dependsOn.some(id => !identities.has(id) || id === step.id))) throw new Error("workflow dependencies are invalid");
  return { name: parseRequiredString(value.name, "workflow name"), version: 1, recordedAt: parseRequiredString(value.recordedAt, "workflow recordedAt"), steps };
}
