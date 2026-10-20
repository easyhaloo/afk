import type { ExecutionStatus, ExecutionSummary } from "../../../shared/execution-contract";
import type { ProjectRun, RuntimeEvent, RuntimeRunEvent } from "../../../shared/ipc-contract";
import { auditedRunRows } from "./run-centre";

/**
 * The legacy record shape of a run: a free-form status beside the display
 * text. The run centre reads the audited rows directly (see run-centre.ts);
 * this is the old shape projected from the same rows, so there is one mapper
 * and one vocabulary.
 */
const legacyStatuses: Record<ExecutionStatus, string> = {
  pending: "queued",
  running: "running",
  awaiting_human: "waiting_confirmation",
  succeeded: "completed",
  failed: "failed",
  cancelled: "failed",
};

export function executionEvents(executions: readonly ExecutionSummary[]): RuntimeEvent[] {
  return auditedRunRows(executions, []).map(legacyEvent);
}

export function executionHistoryEvents(
  executions: readonly ExecutionSummary[],
  workItemRuns: readonly ProjectRun[],
): RuntimeEvent[] {
  return auditedRunRows(executions, workItemRuns).map(legacyEvent);
}

function legacyEvent(row: RuntimeRunEvent): RuntimeEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    source: row.source,
    recordedStatus: legacyStatuses[row.status],
    result: row.result,
    nextStep: row.nextStep,
    raw: row.raw,
    ...(row.usage ? { usage: row.usage } : {}),
  };
}
