import { useState } from "react";
import type { ExecutionRunDetail } from "../../../shared/execution-contract";
import { useExecutionDetail } from "./use-execution-detail";
import { ExecutionHealthView } from "./ExecutionHealthView";

const kindLabels: Record<string, string> = {
  "run.requested": "运行已登记",
  "run.started": "运行开始",
  "run.finished": "运行结束",
  "lease.granted": "获得执行租约",
  "workspace.prepared": "任务空间就绪",
  "workflow.recorded": "本次工作流快照",
  "step.started": "步骤开始",
  "step.completed": "步骤完成",
  "implementation.completed": "实现完成",
  "change.created": "变更创建",
  "change.merge_verified": "合并验证通过",
  "change.published": "变更发布",
  "qa.started": "QA 开始",
  "qa.passed": "QA 通过",
  "qa.failed": "QA 失败",
  "commit.recorded": "提交记录",
  "decision.made": "决策",
  "effect.started": "副作用开始",
  "effect.completed": "副作用完成",
  "human_gate.opened": "人工闸门打开",
  "human_gate.approved": "人工闸门通过",
  "failure.classified": "失败归类",
  "agent.session_recorded": "Agent 会话记录",
};

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN") : value;
}

function entrySummary(entry: ExecutionRunDetail["entries"][number]): string {
  const parts: string[] = [];
  if (entry.stepId) parts.push(entry.stepId);
  if (entry.changeId) parts.push(entry.changeId);
  if (entry.commitSha) parts.push(entry.commitSha.slice(0, 12));
  if (entry.outcome) parts.push(entry.outcome === "failed" ? "失败" : entry.outcome === "cancelled" ? "已取消" : "成功");
  if (entry.failureSummary) parts.push(entry.failureSummary);
  if (entry.reason) parts.push(entry.reason);
  return parts.join(" · ");
}

export function RunTimelineView({ load, runId, workItemId, expanded, running }: { load: (runId: string, workItemId: string) => Promise<ExecutionRunDetail>; runId: string; workItemId: string; expanded: boolean; running: boolean }) {
  const { detail, error } = useExecutionDetail(runId, workItemId, expanded, running, load);

  if (error) {
    return <div className="run-timeline-missing" role="status">无法展示运行时间线：{error}。历史事件缺失或不可重放时不会生成替代内容。</div>;
  }
  if (!detail || detail.runId !== runId || detail.workItemId !== workItemId) return <div className="run-timeline-loading" role="status">正在读取运行事件…</div>;
  if (!detail.entries.length) {
    return <div className="run-timeline-missing" role="status">该运行没有已记录的事件，历史数据不可用。</div>;
  }
  return <>
    <ExecutionHealthView health={detail.health} />
    {!detail.entries.some(entry => entry.kind === "workflow.recorded") ? <p className="run-timeline-missing" role="status">本次运行未记录工作流快照，以下仅展示已记录事件。</p> : null}
    <ol className="run-timeline" aria-label={`运行 ${detail.runId} 事件时间线`}>
    {detail.entries.map(entry => {
      const summary = entrySummary(entry);
      const label = kindLabels[entry.kind] ?? entry.kind;
      return <li className={`run-timeline-entry${entry.outcome === "failed" ? " failed" : ""}`} key={entry.sequence}>
        <time dateTime={entry.occurredAt} title={entry.occurredAt}>{formatTimestamp(entry.occurredAt)}</time>
        <div><b>{label}</b><small> · #{entry.sequence}</small>{entry.phase ? <small> · {entry.phase}</small> : null}{summary ? <small> · {summary}</small> : null}</div>
        {entry.workspacePath ? <code title={entry.workspaceBranch ? `${entry.workspaceBranch} @ ${entry.workspacePath}` : entry.workspacePath}>{entry.workspaceBranch ? `${entry.workspaceBranch} @ ` : ""}{entry.workspacePath}</code> : null}
      </li>;
    })}
    </ol>
  </>;
}

export function RunTimelineSection(props: { load: (runId: string, workItemId: string) => Promise<ExecutionRunDetail>; runId: string; workItemId: string; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="work-item-run-timeline" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary aria-label={`查看运行 ${props.runId} 的执行时间线`}>执行时间线</summary>
    {expanded ? <RunTimelineView {...props} expanded /> : null}
  </details>;
}
