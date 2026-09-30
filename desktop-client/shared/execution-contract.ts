import { parseWorkItemId, type WorkItemId } from "./backlog-contract";
import { assertExactKeys, parseObject, parseRequiredString } from "./validation";

export const EXECUTION_STATUSES = [
  "pending", "running", "awaiting_human", "succeeded", "failed", "cancelled",
] as const;
export const EXECUTION_PHASES = ["implementation", "verification", "release"] as const;

export type ExecutionStatus = typeof EXECUTION_STATUSES[number];

export type ExecutionSummary = {
  runId: string;
  workItemId: WorkItemId;
  profileId: string;
  attempt: number;
  status: ExecutionStatus;
  phase?: typeof EXECUTION_PHASES[number];
  sequence: number;
  terminal: boolean;
};

export type ExecutionQueryOptions = { workItemId?: WorkItemId; limit?: number; since?: string };

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
  assertExactKeys(candidate, ["runId", "workItemId", "profileId", "attempt", "status", "phase", "sequence", "terminal"], "execution summary");
  const workItemId = parseWorkItemId(candidate.workItemId);
  if (!EXECUTION_STATUSES.includes(candidate.status as ExecutionStatus)) throw new Error("execution summary status is invalid");
  if (candidate.phase !== undefined && !EXECUTION_PHASES.includes(candidate.phase as typeof EXECUTION_PHASES[number])) throw new Error("execution summary phase is invalid");
  if (typeof candidate.attempt !== "number" || !Number.isSafeInteger(candidate.attempt) || candidate.attempt < 1) throw new Error("execution summary attempt is invalid");
  if (typeof candidate.sequence !== "number" || !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) throw new Error("execution summary sequence is invalid");
  if (typeof candidate.terminal !== "boolean") throw new Error("execution summary terminal is invalid");
  const summary: ExecutionSummary = {
    runId: parseRequiredString(candidate.runId, "execution summary: runId"),
    workItemId,
    profileId: parseRequiredString(candidate.profileId, "execution summary: profileId"),
    attempt: candidate.attempt,
    status: candidate.status as ExecutionStatus,
    sequence: candidate.sequence,
    terminal: candidate.terminal,
  };
  if (candidate.phase !== undefined) summary.phase = candidate.phase as typeof EXECUTION_PHASES[number];
  return summary;
}
