import type { ExecutionSummary } from "../../../shared/execution-contract";
import type { ProjectRun, RuntimeEvent } from "../../../shared/ipc-contract";

const resultLabels: Record<ExecutionSummary["status"], string> = {
  queued: "工作项等待执行",
  implementing: "工作项正在实现",
  verifying: "工作项正在独立验证",
  publishing: "QA 通过，正在提交 PR",
  awaiting_merge: "PR 等待人工合并",
  rework: "QA 未通过，等待返工",
  blocked: "工作项执行受阻",
  failed: "工作项执行失败",
  done: "工作项已完成",
  unknown: "运行审计待核查",
};

export function executionEvents(executions: readonly ExecutionSummary[]): RuntimeEvent[] {
  return executions.map(execution => ({
    id: execution.executionId,
    timestamp: execution.updatedAt ?? execution.startedAt ?? "—",
    source: execution.workItemId,
    status: execution.status === "queued" ? "queued"
      : execution.status === "done" ? "completed"
        : execution.status === "failed" || execution.status === "rework" || execution.status === "blocked" ? "failed"
          : execution.status === "unknown" || execution.status === "awaiting_merge" ? "waiting_confirmation" : "running",
    result: resultLabels[execution.status],
    nextStep: execution.workspacePath ? `任务空间：${execution.workspacePath}` : execution.diagnostic ?? resultLabels[execution.status],
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
