import { ClipboardList, ListChecks, TerminalSquare, Workflow } from "lucide-react";
import type { ExecutionRunDetail, ExecutionSummary } from "../../../shared/execution-contract";
import { ExecutionHealthView } from "../run-center/ExecutionHealthView";
import { useExecutionDetail } from "../run-center/use-execution-detail";

export type ExecutionSelection = { runId: string; workItemId: string };
const statusLabels = { pending: "待执行", running: "执行中", awaiting_human: "等待人工处理", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
const stepLabels = { pending: "待执行", running: "执行中", succeeded: "成功", failed: "失败", cancelled: "已取消" };

export function WorkflowInstancesPage({ executions, selection, onSelect, onRun, onWorkItem, onEnvironment, onAttach, onDefinition }: {
  executions: ExecutionSummary[];
  selection?: ExecutionSelection;
  onSelect: (selection: ExecutionSelection) => void;
  onRun: (selection: ExecutionSelection) => void;
  onWorkItem: (workItemId: string) => void;
  onEnvironment: (selection: ExecutionSelection) => void;
  onAttach: (runId: string) => void;
  onDefinition: (detail: ExecutionRunDetail) => void;
}) {
  const selected = selection ?? executions[0];
  const summary = executions.find(run => run.runId === selected?.runId);
  const { detail, error } = useExecutionDetail(selected?.runId ?? "", selected?.workItemId ?? "", !!selected, !summary?.terminal,
    (runId, workItemId) => window.afkDesktop.workItems.executionRunDetail(runId, workItemId));
  return <section className="workflow-instances" aria-label="工作流实例">
    <header><h1>工作流实例</h1><p>每次运行保留自己的工作流快照，模板修改只影响后续运行。</p></header>
    <div className="workflow-instance-layout">
      <nav aria-label="选择工作流实例">
        {executions.map(run => <button type="button" key={run.runId} aria-pressed={run.runId === selected?.runId} onClick={() => onSelect(run)}>
          <b>{run.workItemId}</b><code>{run.runId}</code><small>{statusLabels[run.status]}</small>
        </button>)}
        {!executions.length ? <p>暂无审计运行记录。</p> : <small>显示最近 {executions.length} 次运行；从工作项打开可直接定位其他运行。</small>}
      </nav>
      <article aria-label="工作流实例详情">
        {error ? <p role="alert">无法读取该实例：{error}</p> : selected && !detail ? <p role="status">正在读取本次工作流…</p> : detail ? <>
          <h2>{detail.workflow?.name ?? "历史工作流实例"}</h2>
          <code>{detail.runId}</code><p>{detail.workItemId} · 审计进度：{detail.status ? statusLabels[detail.status] : "未知"}</p>
          <div className="workflow-instance-actions">
            <button type="button" aria-label="查看本次运行" title="运行中心" onClick={() => onRun(detail)}><ListChecks size={16} /></button>
            <button type="button" aria-label="查看关联工作项" title="工作项" onClick={() => onWorkItem(detail.workItemId)}><ClipboardList size={16} /></button>
            <button type="button" aria-label="查看本次执行环境" title="执行环境" onClick={() => onEnvironment(detail)}><TerminalSquare size={16} /></button>
            <button type="button" aria-label="接管本次 Agent" title="接管本次 Agent" onClick={() => onAttach(detail.runId)}><TerminalSquare size={16} /></button>
            <button type="button" aria-label="查看当前工作流定义" title="当前定义（独立于实例快照）" disabled={!detail.workflow || !detail.workspacePath} onClick={() => onDefinition(detail)}><Workflow size={16} /></button>
          </div>
          <ExecutionHealthView health={detail.health} />
          {detail.workspacePath ? <p className="workflow-instance-workspace">任务目录：<code>{detail.workspacePath}</code> · {detail.workspaceBranch}</p> : null}
          {detail.workflow ? <>
            <h3>本次快照 · v{detail.workflow.version}</h3><p>记录于 {new Date(detail.workflow.recordedAt).toLocaleString("zh-CN")}</p>
            <table><thead><tr><th>步骤</th><th>依赖</th><th>Agent / 模式</th><th>状态</th></tr></thead><tbody>
              {detail.workflow.steps.map(step => <tr key={step.id}><th>{step.id}</th><td>{step.dependsOn.join(" · ") || "无"}</td><td>{step.provider ?? (step.kind === "system" ? "系统" : "未记录")} · {step.executionMode ?? "未记录"}</td><td>{stepLabels[step.status]}</td></tr>)}
            </tbody></table>
          </> : <p role="status">本次运行没有工作流快照，不能用当前模板替代历史实例。可在运行中心查看已记录事件。</p>}
        </> : <p>选择一次运行查看其工作流实例。</p>}
      </article>
    </div>
  </section>;
}
