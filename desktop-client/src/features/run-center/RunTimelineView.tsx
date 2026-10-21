import { useState } from "react";
import { Check, ChevronRight, Circle, CircleAlert, Clock3, ListChecks } from "lucide-react";
import type { ExecutionRunDetail } from "../../../shared/execution-contract";
import { ResourceSearch } from "../../components/ResourceSearch";
import { SegmentedControl } from "../../components/SegmentedControl";
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

export function RunEventLog({ detail }: { detail: ExecutionRunDetail }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "failure">("all");
  const failures = new Set(detail.entries.filter(entry => entry.outcome === "failed" || entry.outcome === "cancelled" || entry.kind.endsWith(".failed") || entry.kind === "failure.classified").map(entry => entry.sequence));
  const search = query.trim().toLowerCase();
  const entries = detail.entries.filter(entry => (filter === "all" || failures.has(entry.sequence))
    && [kindLabels[entry.kind], entry.kind, entry.phase, entrySummary(entry), entry.workspacePath, entry.workspaceBranch, entry.branch, `#${entry.sequence}`].join(" ").toLowerCase().includes(search));

  if (!detail.integrityValid) return <p className="run-timeline-missing" role="alert">无法展示运行时间线：{detail.integrityReason ?? "审计完整性校验未通过"}。历史事件缺失或不可重放时不会生成替代内容。</p>;
  if (!detail.entries.length) return <div className="run-timeline-missing" role="status">该运行没有已记录的事件，历史数据不可用。</div>;

  return <section className="run-event-log" aria-label="运行日志">
    <div className="run-log-toolbar">
      <SegmentedControl label="日志筛选" value={filter} options={[{ value: "all", label: "全部", count: detail.entries.length }, { value: "failure", label: "异常", count: failures.size }]} onChange={setFilter} />
      <ResourceSearch label="搜索运行日志" value={query} onChange={setQuery} />
    </div>
    <div className="run-log-caption"><span><ListChecks size={13} aria-hidden="true" />事件流</span><small>{entries.length} 条 · 按记录顺序</small></div>
    {!detail.entries.some(entry => entry.kind === "workflow.recorded") ? <p className="run-log-notice" role="status">本次运行未记录工作流快照，以下仅展示已记录事件。</p> : null}
    {entries.length ? <ol className="run-timeline" aria-label={`运行 ${detail.runId} 事件时间线`}>
      {entries.map(entry => {
        const failed = failures.has(entry.sequence);
        const completed = entry.outcome === "succeeded" || entry.kind.endsWith(".completed") || entry.kind.endsWith(".passed") || entry.kind === "workspace.prepared";
        const EventIcon = failed ? CircleAlert : completed ? Check : entry.kind.endsWith(".started") ? Clock3 : Circle;
        const phase = entry.phase === "implementation" ? "实现" : entry.phase === "verification" ? "验证" : entry.phase === "release" ? "发布" : undefined;
        return <li className={`run-timeline-entry${failed ? " failed" : completed ? " completed" : ""}`} key={entry.sequence}>
          <details className="run-log-event">
            <summary>
              <time dateTime={entry.occurredAt} title={formatTimestamp(entry.occurredAt)}>{new Date(entry.occurredAt).toLocaleTimeString("zh-CN", { hour12: false })}</time>
              <span className="run-log-glyph"><EventIcon size={13} aria-hidden="true" /></span>
              <span className="run-log-copy"><span><b>{kindLabels[entry.kind] ?? entry.kind}</b><small>#{entry.sequence}{phase ? ` · ${phase}` : ""}</small></span><span className="run-log-description">{entrySummary(entry) || entry.kind}</span></span>
              <ChevronRight className="run-log-chevron" size={14} aria-hidden="true" />
            </summary>
            <dl className="run-log-fields">
              <div><dt>事件类型</dt><dd><code>{entry.kind}</code></dd></div>
              <div><dt>记录时间</dt><dd>{formatTimestamp(entry.occurredAt)}</dd></div>
              {entry.stepId ? <div><dt>步骤</dt><dd><code>{entry.stepId}</code></dd></div> : null}
              {entry.workspacePath ? <div><dt>任务目录</dt><dd><code>{entry.workspacePath}</code></dd></div> : null}
              {entry.workspaceBranch || entry.branch ? <div><dt>分支</dt><dd><code>{entry.workspaceBranch ?? entry.branch}</code></dd></div> : null}
              {entry.changeId ? <div><dt>变更</dt><dd>{entry.changeId}</dd></div> : null}
              {entry.commitSha ? <div><dt>提交</dt><dd><code>{entry.commitSha}</code></dd></div> : null}
              {entry.failureSummary ? <div><dt>失败原因</dt><dd>{entry.failureSummary}</dd></div> : null}
              {entry.reason ? <div><dt>说明</dt><dd>{entry.reason}</dd></div> : null}
            </dl>
          </details>
        </li>;
      })}
    </ol> : <div className="run-log-empty" role="status"><ListChecks size={24} aria-hidden="true" /><b>没有匹配的运行日志</b><span>调整搜索词或日志筛选。</span></div>}
  </section>;
}

export function RunTimelineView({ load, runId, workItemId, expanded, running }: { load: (runId: string, workItemId: string) => Promise<ExecutionRunDetail>; runId: string; workItemId: string; expanded: boolean; running: boolean }) {
  const { detail, error } = useExecutionDetail(runId, workItemId, expanded, running, load);

  if (error) {
    return <div className="run-timeline-missing" role="status">无法展示运行时间线：{error}。历史事件缺失或不可重放时不会生成替代内容。</div>;
  }
  if (!detail || detail.runId !== runId || detail.workItemId !== workItemId) return <div className="run-timeline-loading" role="status">正在读取运行事件…</div>;
  return <>
    <ExecutionHealthView health={detail.health} />
    <RunEventLog key={detail.runId} detail={detail} />
  </>;
}

export function RunTimelineSection(props: { load: (runId: string, workItemId: string) => Promise<ExecutionRunDetail>; runId: string; workItemId: string; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="work-item-run-timeline" onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
    <summary aria-label={`查看运行 ${props.runId} 的执行时间线`}><ListChecks size={14} aria-hidden="true" /><span>运行日志</span><ChevronRight size={14} aria-hidden="true" /></summary>
    {expanded ? <RunTimelineView {...props} expanded /> : null}
  </details>;
}
