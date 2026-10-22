import { useState } from "react";
import { Bot, Check, CircleCheck, CircleDashed, CircleX, ClipboardList, Clock3, GitBranch, ListChecks, SquareTerminal, TerminalSquare, Workflow } from "lucide-react";
import type { ExecutionRunDetail, ExecutionSummary } from "../../../shared/execution-contract.js";
import { ResourceSearch } from "../../components/ResourceSearch.js";
import { SegmentedControl } from "../../components/SegmentedControl.js";
import { ExecutionHealthView } from "../run-center/ExecutionHealthView.js";
import { RunEventLog } from "../run-center/RunTimelineView.js";
import { useExecutionDetail } from "../run-center/use-execution-detail.js";

export type ExecutionSelection = { runId: string; workItemId: string };
const statusLabels = { pending: "待执行", running: "执行中", awaiting_human: "等待人工处理", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
const statusIcons = { pending: CircleDashed, running: Clock3, awaiting_human: Clock3, succeeded: CircleCheck, failed: CircleX, cancelled: CircleX };
const stepLabels = { pending: "待执行", running: "执行中", succeeded: "成功", failed: "失败", cancelled: "已取消" };

export function WorkflowInstancesPage({ executions, selection, onSelect, onRun, onWorkItem, onEnvironment, onAttach, onDefinition, hasMore, onLoadMore }: {
  executions: ExecutionSummary[];
  selection?: ExecutionSelection;
  onSelect: (selection: ExecutionSelection) => void;
  onRun: (selection: ExecutionSelection) => void;
  onWorkItem: (workItemId: string) => void;
  onEnvironment: (selection: ExecutionSelection) => void;
  onAttach: (runId: string) => void;
  onDefinition: (detail: ExecutionRunDetail) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "fail">("all");
  const [tab, setTab] = useState<"snapshot" | "logs">("snapshot");
  const selected = selection ?? executions[0];
  const summary = executions.find(run => run.runId === selected?.runId && run.workItemId === selected?.workItemId);
  const { detail, error } = useExecutionDetail(selected?.runId ?? "", selected?.workItemId ?? "", !!selected, !summary?.terminal,
    (runId, workItemId) => window.afkDesktop.workItems.executionRunDetail(runId, workItemId));
  const runs: Array<ExecutionSelection & { status?: ExecutionSummary["status"]; attempt?: number; profileId?: string }> = selected && !summary ? [{ ...selected, status: detail?.status }, ...executions] : executions;
  const search = query.trim().toLowerCase();
  const visible = runs.filter(run => (filter === "all" || (filter === "fail" ? run.status === "failed" : run.status === "running" || run.status === "awaiting_human" || run.status === "pending"))
    && `${run.runId} ${run.workItemId} ${run.profileId ?? ""} ${run.status ? statusLabels[run.status] : ""}`.toLowerCase().includes(search));
  const StatusIcon = detail?.status ? statusIcons[detail.status] : CircleDashed;
  return <section className="workflow-instances" aria-label="工作流实例">
    <header className="workflow-instances-heading"><div><h1>工作流实例</h1><p>查看每次运行的工作流快照与执行记录</p></div><span>{runs.length} 个实例</span></header>
    <div className="workflow-instance-layout">
      <aside className="workflow-instance-list">
        <div className="workflow-instance-search"><ResourceSearch label="搜索工作流实例" value={query} onChange={setQuery} /><SegmentedControl label="实例筛选" value={filter} options={[{ value: "all", label: "全部" }, { value: "open", label: "进行中" }, { value: "fail", label: "失败" }]} onChange={setFilter} /></div>
        <nav aria-label="选择工作流实例">
          {visible.map(run => {
            const Icon = run.status ? statusIcons[run.status] : CircleDashed;
            return <button type="button" className="workflow-instance-row" key={run.runId} aria-pressed={run.runId === selected?.runId && run.workItemId === selected?.workItemId} onClick={() => onSelect(run)}>
              <Icon className={`execution-status-icon ${run.status ?? "pending"}`} size={16} aria-hidden="true" />
              <span><b title={run.workItemId}>{run.workItemId}</b><code title={run.runId}>{run.runId}</code><small>{run.status ? statusLabels[run.status] : "正在读取"}{run.attempt ? ` · 第 ${run.attempt} 次` : ""}</small></span>
            </button>;
          })}
          {!visible.length ? <p className="workflow-instance-list-empty" role="status">{runs.length ? "没有匹配的工作流实例" : "暂无审计运行记录"}</p> : null}
        </nav>
        <footer>{hasMore && onLoadMore ? <button type="button" onClick={onLoadMore}>查看更多运行实例</button> : <span>已加载 {executions.length} 次运行</span>}</footer>
      </aside>
      <article className="workflow-instance-detail" aria-label="工作流实例详情" aria-busy={!!selected && !detail && !error}>
        {error ? <p className="run-timeline-missing" role="alert">无法读取该实例：{error}</p> : selected && !detail ? <p className="run-timeline-loading" role="status">正在读取本次工作流…</p> : detail ? <>
          <header className="workflow-instance-detail-heading">
            <div><span className={`execution-status-badge ${detail.status ?? "pending"}`}><StatusIcon size={13} aria-hidden="true" />审计进度：{detail.status ? statusLabels[detail.status] : "未知"}</span><h2>{detail.workflow?.name ?? "历史工作流实例"}</h2><code>{detail.runId}</code></div>
            <div className="workflow-instance-actions">
              <button type="button" aria-label="查看本次运行" title="运行中心" onClick={() => onRun(detail)}><ListChecks size={16} /></button>
              <button type="button" aria-label="查看关联工作项" title="工作项" onClick={() => onWorkItem(detail.workItemId)}><ClipboardList size={16} /></button>
              <button type="button" aria-label="查看本次执行环境" title="执行环境" onClick={() => onEnvironment(detail)}><TerminalSquare size={16} /></button>
              <button type="button" aria-label="接管本次 Agent" title="接管本次 Agent" onClick={() => onAttach(detail.runId)}><SquareTerminal size={16} /></button>
              <button type="button" aria-label="查看当前工作流定义" title="当前工作流定义" disabled={!detail.workflow || !detail.workspacePath} onClick={() => onDefinition(detail)}><Workflow size={16} /></button>
            </div>
          </header>
          <dl className="workflow-instance-context">
            <div><dt>工作项</dt><dd>{detail.workItemId}</dd></div>
            <div><dt>分支</dt><dd>{detail.workspaceBranch ?? "未记录"}</dd></div>
            {detail.startedAt ? <div><dt>开始时间</dt><dd>{new Date(detail.startedAt).toLocaleString("zh-CN")}</dd></div> : null}
            {detail.updatedAt ? <div><dt>最近更新</dt><dd>{new Date(detail.updatedAt).toLocaleString("zh-CN")}</dd></div> : null}
            {detail.workspacePath ? <div className="workflow-instance-workspace"><dt>任务目录</dt><dd><code>{detail.workspacePath}</code></dd></div> : null}
          </dl>
          <ExecutionHealthView health={detail.health} />
          <div className="workflow-instance-tabs"><SegmentedControl label="实例详情视图" value={tab} options={[{ value: "snapshot", label: "工作流快照" }, { value: "logs", label: "运行日志", count: detail.entries.length }]} onChange={setTab} /></div>
          {tab === "logs" ? <RunEventLog key={detail.runId} detail={detail} /> : detail.workflow ? <section className="workflow-instance-snapshot">
            <header><h3>本次快照 · v{detail.workflow.version}</h3><span>{detail.workflow.steps.filter(step => step.status === "succeeded").length} / {detail.workflow.steps.length} 个步骤已完成</span></header>
            <ol className="workflow-instance-steps" aria-label="本次工作流快照">
              {detail.workflow.steps.map(step => {
                const StepIcon = step.status === "succeeded" ? Check : statusIcons[step.status];
                return <li key={step.id} className={step.status}>
                  <span className={`workflow-instance-step-glyph execution-status-icon ${step.status}`}><StepIcon size={15} aria-hidden="true" /></span>
                  <div><div className="workflow-instance-step-heading"><b>{step.id}</b><span className={`execution-status-badge ${step.status}`}>{stepLabels[step.status]}</span></div><small><Bot size={12} aria-hidden="true" />{step.provider ?? (step.kind === "system" ? "系统" : "未记录 Agent")} · {step.executionMode === "interactive" ? "交互模式" : step.executionMode === "batch" ? "批处理模式" : "未记录模式"}</small><p><GitBranch size={12} aria-hidden="true" />{step.dependsOn.length ? `依赖 ${step.dependsOn.join(" · ")}` : "无前置依赖"}</p></div>
                </li>;
              })}
            </ol>
            <footer>记录于 {new Date(detail.workflow.recordedAt).toLocaleString("zh-CN")} · 模板修改只影响后续运行</footer>
          </section> : <p className="run-timeline-missing" role="status">本次运行没有工作流快照，不能用当前模板替代历史实例。可在运行日志查看已记录事件。</p>}
        </> : <div className="workflow-instance-empty"><Workflow size={30} aria-hidden="true" /><h2>选择一个运行实例</h2><p>在左侧查看已记录的工作流快照和运行日志。</p></div>}
      </article>
    </div>
  </section>;
}
