import type { ExecutionStatus, ExecutionSummary } from "../../../shared/execution-contract";
import type { ProjectRun, RuntimeRunEvent } from "../../../shared/ipc-contract";
import type { RuntimeVisualState } from "./runtime-presentation";

/** What the audited status reads as in the run centre. */
const statusLabels: Record<ExecutionStatus, string> = {
  pending: "工作项等待执行",
  running: "工作项正在执行",
  awaiting_human: "工作项等待人工处理",
  succeeded: "工作项已完成",
  failed: "工作项执行失败",
  cancelled: "工作项执行已取消",
};

/**
 * The visual state of a run, computed from the audited status. One table, one
 * authority: the same status always yields the same state, and nothing is
 * read out of a sentence.
 */
const visualStates: Record<ExecutionStatus, RuntimeVisualState> = {
  pending: "ready",
  running: "active",
  awaiting_human: "attention",
  succeeded: "verify",
  failed: "failed",
  cancelled: "failed",
};

/**
 * The legacy snapshot record's own vocabulary, mapped onto the audited
 * statuses. An explicit adapter: the old record says which state it was in,
 * so the run centre reads that state instead of guessing at it.
 */
const legacyStatuses: Record<ProjectRun["status"], ExecutionStatus> = {
  starting: "pending",
  running: "running",
  // The old record says the implementation process exited but QA never
  // verified it, so the run is waiting, not done.
  completed: "awaiting_human",
  failed: "failed",
};

const legacyLabels: Record<ProjectRun["status"], string> = {
  starting: "旧记录：工作项正在启动",
  running: "旧记录：工作项正在执行",
  completed: "旧记录：实现进程已退出，QA 未验证",
  failed: "旧记录：工作项执行失败",
};

export type RunLanes = Record<RuntimeVisualState, RuntimeRunEvent[]>;

export type RunCounts = {
  running: number;
  waiting: number;
  failed: number;
  done: number;
  tokens: number;
};

export type RunCentreModel = {
  rows: RuntimeRunEvent[];
  lanes: RunLanes;
  counts: RunCounts;
};

export type RunFilter = "all" | "open" | "fail";

/** The visual state of a run, computed from the audited status. */
export function runVisualState(status: ExecutionStatus): RuntimeVisualState {
  return visualStates[status];
}

/** The run's workspace path — read from the field, never parsed out of prose. */
export function runWorkspacePath(row: RuntimeRunEvent): string | null {
  return row.workspacePath ?? null;
}

/**
 * The run centre's rows: the audited summaries, plus the legacy snapshot
 * records the snapshot pipeline still reports. Both carry an audited status,
 * so both take part in the same lanes and the same counts.
 */
export function auditedRunRows(
  executions: readonly ExecutionSummary[],
  workItemRuns: readonly ProjectRun[],
): RuntimeRunEvent[] {
  return [...executions.map(auditedRow), ...workItemRuns.map(legacyRow)];
}

function auditedRow(execution: ExecutionSummary): RuntimeRunEvent {
  const label = statusLabels[execution.status];
  // A run whose event chain is broken describes only the prefix the chain
  // vouches for. Say so rather than presenting it as a whole run.
  const broken = execution.integrityValid === false;
  return {
    id: execution.runId,
    timestamp: execution.updatedAt ?? execution.startedAt ?? "—",
    source: execution.workItemId,
    status: execution.status,
    ...(execution.phase ? { phase: execution.phase } : {}),
    integrityValid: execution.integrityValid,
    result: broken ? `审计链不完整：${label}` : label,
    nextStep: broken ? "审计链不完整，仅显示已验证部分" : label,
    raw: JSON.stringify(execution),
    ...(execution.usage ? { usage: execution.usage } : {}),
  };
}

function legacyRow(run: ProjectRun): RuntimeRunEvent {
  return {
    id: `work-item-run-${run.id}`,
    timestamp: run.startedAt,
    source: run.workItemId,
    status: legacyStatuses[run.status],
    // The old record knows its workspace path; it is a field, not a sentence.
    workspacePath: run.workspacePath,
    result: legacyLabels[run.status],
    nextStep: "",
    raw: JSON.stringify(run),
  };
}

/** The rows of each visual state. */
export function runLanes(rows: readonly RuntimeRunEvent[]): RunLanes {
  const lanes: RunLanes = { ready: [], active: [], verify: [], attention: [], failed: [] };
  for (const row of rows) lanes[runVisualState(row.status)].push(row);
  return lanes;
}

/**
 * The header counts and the lanes are read from the same rows, so a run that
 * is running cannot be counted as running and shown as anything else.
 */
export function buildRunCentre(
  executions: readonly ExecutionSummary[],
  workItemRuns: readonly ProjectRun[],
): RunCentreModel {
  const rows = auditedRunRows(executions, workItemRuns);
  const lanes = runLanes(rows);
  return {
    rows,
    lanes,
    counts: {
      running: lanes.active.length,
      waiting: lanes.attention.length,
      failed: lanes.failed.length,
      done: lanes.verify.length,
      tokens: rows.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0),
    },
  };
}

/** The rows the run filter keeps. */
export function filterRunRows(rows: readonly RuntimeRunEvent[], filter: RunFilter): RuntimeRunEvent[] {
  if (filter === "all") return [...rows];
  if (filter === "open") {
    return rows.filter(row => row.status === "running" || row.status === "awaiting_human");
  }
  return rows.filter(row => row.status === "failed" || row.status === "cancelled");
}
