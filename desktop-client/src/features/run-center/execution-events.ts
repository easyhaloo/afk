import type { ExecutionSummary } from "../../../shared/execution-contract";
import type { ProjectRun, RuntimeEvent } from "../../../shared/ipc-contract";

const resultLabels: Record<ExecutionSummary["status"], string> = {
  pending: "工作项等待执行",
  running: "工作项正在执行",
  awaiting_human: "工作项等待人工处理",
  succeeded: "工作项已完成",
  failed: "工作项执行失败",
  cancelled: "工作项执行已取消",
};

export function executionEvents(executions: readonly ExecutionSummary[]): RuntimeEvent[] {
  return executions.map(execution => ({
    id: execution.runId,
    timestamp: "—",
    source: execution.workItemId,
    status: execution.status === "pending" ? "queued"
      : execution.status === "succeeded" ? "completed"
        : execution.status === "failed" || execution.status === "cancelled" ? "failed"
          : execution.status === "awaiting_human" ? "waiting_confirmation" : "running",
    result: resultLabels[execution.status],
    nextStep: resultLabels[execution.status],
    raw: JSON.stringify(execution),
  }));
}

export function executionHistoryEvents(
  executions: readonly ExecutionSummary[],
  workItemRuns: readonly ProjectRun[],
): RuntimeEvent[] {
  return [
    ...executionEvents(executions),
    ...workItemRuns.map((run): RuntimeEvent => ({
      id: `work-item-run-${run.id}`,
      timestamp: run.startedAt,
      source: run.workItemId,
      status: run.status === "starting" ? "queued" : run.status === "completed" ? "waiting_confirmation" : run.status,
      result: run.status === "running" ? "旧记录：工作项正在执行" : run.status === "starting" ? "旧记录：工作项正在启动" : run.status === "completed" ? "旧记录：实现进程已退出，QA 未验证" : "旧记录：工作项执行失败",
      nextStep: `任务空间：${run.workspacePath}`,
      raw: JSON.stringify(run),
    })),
  ];
}
