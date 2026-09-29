import { parseProviderProjectRef, parseWorkItemId, type ProviderProjectRef, type WorkItemId } from "./backlog-contract";
import { assertExactKeys, parseObject, parseRequiredString } from "./validation";

export const EXECUTION_STATUSES = [
  "queued", "implementing", "verifying", "publishing", "awaiting_merge", "rework", "blocked", "failed", "done", "unknown",
] as const;

export type ExecutionStatus = typeof EXECUTION_STATUSES[number];

export type ExecutionSummary = {
  executionId: string;
  runId?: string;
  workItemId: WorkItemId;
  project: ProviderProjectRef;
  status: ExecutionStatus;
  startedAt?: string;
  updatedAt?: string;
  workspacePath?: string;
  pr?: { id: string; url: string; state: "open" | "merged" | "closed" };
  diagnostic?: string;
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

function parseTimestamp(value: unknown, label: string): string {
  const timestamp = parseRequiredString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid`);
  return timestamp;
}

export function parseExecutionSummary(input: unknown): ExecutionSummary {
  const candidate = parseObject(input, "execution summary");
  assertExactKeys(candidate, ["executionId", "runId", "workItemId", "project", "status", "startedAt", "updatedAt", "workspacePath", "pr", "diagnostic"], "execution summary");
  const workItemId = parseWorkItemId(candidate.workItemId);
  const project = parseProviderProjectRef(candidate.project);
  if (!workItemId.startsWith(`${project.platform}:${project.projectKey}#`)) throw new Error("execution summary project does not match work item");
  if (!EXECUTION_STATUSES.includes(candidate.status as ExecutionStatus)) throw new Error("execution summary status is invalid");
  const summary: ExecutionSummary = {
    executionId: parseRequiredString(candidate.executionId, "execution summary: executionId"),
    workItemId,
    project,
    status: candidate.status as ExecutionStatus,
  };
  if (candidate.runId !== undefined) summary.runId = parseRequiredString(candidate.runId, "execution summary: runId");
  if (candidate.startedAt !== undefined) summary.startedAt = parseTimestamp(candidate.startedAt, "execution summary: startedAt");
  if (candidate.updatedAt !== undefined) summary.updatedAt = parseTimestamp(candidate.updatedAt, "execution summary: updatedAt");
  if (summary.status !== "unknown" && (!summary.startedAt || !summary.updatedAt)) throw new Error("execution summary requires timestamps");
  if (summary.startedAt && summary.updatedAt && Date.parse(summary.updatedAt) < Date.parse(summary.startedAt)) throw new Error("execution summary updatedAt precedes startedAt");
  if (candidate.workspacePath !== undefined) summary.workspacePath = parseRequiredString(candidate.workspacePath, "execution summary: workspacePath");
  if (candidate.diagnostic !== undefined) summary.diagnostic = parseRequiredString(candidate.diagnostic, "execution summary: diagnostic");
  if (candidate.pr !== undefined) {
    const pr = parseObject(candidate.pr, "execution summary PR");
    assertExactKeys(pr, ["id", "url", "state"], "execution summary PR");
    if (pr.state !== "open" && pr.state !== "merged" && pr.state !== "closed") throw new Error("execution summary PR state is invalid");
    const url = parseRequiredString(pr.url, "execution summary PR url");
    if (!/^https:\/\//.test(url)) throw new Error("execution summary PR url is invalid");
    summary.pr = { id: parseRequiredString(pr.id, "execution summary PR id"), url, state: pr.state };
  }
  return summary;
}
