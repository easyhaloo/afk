import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DesktopLearningApi, DesktopLearningCandidate, DesktopLearningPublicationResult } from "../../../shared/learning-contract.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { useLearning } from "./use-learning.js";
import "./learning.css";

export type LearningViewProps = { api?: DesktopLearningApi; enabled?: boolean };
const states = { candidate: "待验证", conflict: "冲突", validated: "已验证", published: "已发布", rejected: "已拒绝", superseded: "已替代", revoked: "已撤销" };
const kinds = { fact: "事实", process: "流程", lesson: "经验", skill: "技能", tool: "工具" };
const phases = { prepared: "已准备", applied: "已应用，待提交", committed: "已提交", conflict: "冲突", superseded: "已替代" };
const jobStates = { pending: "待处理", blocked: "受阻", failed: "失败", processed: "已处理" };

function PublicationResult({ result }: { result: DesktopLearningPublicationResult }) {
  const outcome = result.withdrawal?.status === "withdrawn" ? "已撤回"
    : result.withdrawal?.status === "rollback_blocked" ? "撤回受阻"
    : result.errorCode !== undefined ? "发布错误" : phases[result.publication.phase];
  return <li><b>{outcome}</b><span>{result.publication.targetRef}</span><code>{result.publication.key}</code>
    {result.withdrawal || result.errorCode !== undefined ? <small>历史发布阶段：{phases[result.publication.phase]}</small> : null}
    <small>候选 {result.publication.candidateId} · v{result.publication.candidateVersion}</small>
    {result.wikiStatus ? <small>Wiki：{result.wikiStatus}</small> : null}
    {result.errorCode !== undefined ? <small>错误码：{result.errorCode}</small> : null}
    {result.withdrawal ? <small>恢复状态：{result.withdrawal.status === "withdrawn" ? "已回退" : "回退受阻"}</small> : null}
  </li>;
}

function CandidateSummary({ candidate }: { candidate: DesktopLearningCandidate }) {
  return <><b>{candidate.title}</b><small>{kinds[candidate.kind]} · {states[candidate.state]} · v{candidate.version} · {candidate.evidenceCount} 条证据</small>
    <code>{candidate.id}</code>{candidate.targetRef ? <small>目标：{candidate.targetRef}</small> : null}</>;
}

export function LearningView({ api, enabled = true }: LearningViewProps) {
  const data = useLearning(api, enabled);
  const [checkerId, setCheckerId] = useState("");
  useEffect(() => { setCheckerId(""); }, [api, enabled, data.scope, data.selectedId]);
  const busy = data.loading || data.mutating;
  const available = !!api && enabled;
  const canValidate = !!data.selected && ["candidate", "conflict"].includes(data.selected.state)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(checkerId);
  const canPrepare = data.selected?.state === "validated" && ["fact", "process"].includes(data.selected.kind);
  return <section className="control-page learning-view" aria-label="学习治理" aria-busy={busy}>
    <header className="control-page-heading"><div><p>学习与知识</p><h1>学习治理</h1><span>按项目查看候选与任务。验证、准备和发布仅在明确操作后执行。</span></div></header>
    {!api ? <p role="status">学习后端未接入，请完成 Desktop 学习服务配置。</p> : !enabled ? <p role="status">学习治理未启用，请在插件配置中启用后重新进入。</p> : null}
    <section className="settings-section" aria-label="学习项目与数据"><header><div><b>项目范围</b><small>仅展示当前项目的元数据，不展示原始证据或页面正文。</small></div></header>
      <div className="learning-toolbar"><SelectMenu label="学习项目" placeholder="选择项目" value={data.scope} options={data.projects.map(project => ({ value: project, label: project }))}
        disabled={!available || data.mutating || (data.loading && !data.scope)} onChange={data.selectScope} search={{ label: "搜索学习项目" }} />
        <button type="button" aria-label="重新读取学习数据" title="重新读取项目、候选与任务" disabled={!available || busy} onClick={() => { void data.refresh(); }}><RefreshCw size={16} /></button>
      </div>
      {available && !data.loading && !data.projects.length && !data.error ? <p className="learning-note">暂无可用项目，请先配置工作项来源。</p> : null}
      {available && data.projects.length > 0 && !data.scope ? <p className="learning-note">请选择项目以读取学习候选与任务。</p> : null}
      {data.loading ? <p role="status">正在读取学习数据…</p> : null}
      {data.mutating ? <p role="status">操作进行中，请等待结果；离开页面不会取消后端操作。</p> : null}
      {data.error ? <p role="alert">{data.error}</p> : null}
      {data.notice ? <p role="status" aria-live="polite">{data.notice}</p> : null}
    </section>
    <div className="learning-columns">
      <section className="settings-section" aria-label="学习候选"><header><div><b>学习候选</b><small>最多展示 100 项；待验证候选不会自动成为知识。</small></div></header>
        {data.scope && !data.loading && !data.error && !data.candidates.length ? <p className="learning-note">暂无学习候选。</p> : null}
        <ul className="learning-list">{data.candidates.map(candidate => <li key={candidate.id}><button type="button" className="learning-candidate" aria-label={`选择候选 ${candidate.id}`} aria-pressed={data.selectedId === candidate.id}
          disabled={busy} onClick={() => data.selectCandidate(candidate.id)}><CandidateSummary candidate={candidate} /></button></li>)}</ul>
      </section>
      <section className="settings-section" aria-label="候选验证与知识发布"><header><div><b>候选验证与知识发布</b><small>验证器来自已有配置，不接受命令、路径或人工通过标记。</small></div></header>
        <div className="learning-detail">{data.selected ? <CandidateSummary candidate={data.selected} /> : <p className="learning-note">请选择候选以验证或准备知识。</p>}
          <label>验证器 ID<input aria-label="验证器 ID" placeholder="已配置的 checkerId" value={checkerId} maxLength={128} disabled={!available || !data.selected || busy} onChange={event => setCheckerId(event.target.value)} /></label>
          <div className="learning-actions"><button type="button" aria-label="验证候选" disabled={!available || busy || !canValidate} onClick={() => { void data.validate(checkerId); }}>验证候选</button>
            <button type="button" aria-label="准备知识预览" disabled={!available || busy || !canPrepare} onClick={() => { void data.prepare(); }}>准备知识预览</button></div>
          {data.selected && !["fact", "process"].includes(data.selected.kind) ? <p className="learning-note">此类候选当前不支持知识发布。</p> : null}
          {data.preview ? <section className="learning-preview" aria-label="知识预览"><h2>知识预览</h2><p>仅含发布计划元数据，不包含页面正文或内容差异。</p>
            <dl><dt>目标</dt><dd>{data.preview.targetRef}</dd><dt>阶段</dt><dd>{phases[data.preview.phase]}</dd><dt>候选版本</dt><dd>v{data.preview.candidateVersion}</dd><dt>发布键</dt><dd><code>{data.preview.key}</code></dd></dl></section> : null}
          <button type="button" aria-label="发布知识" disabled={!available || busy || !data.preview} onClick={() => { void data.publish(); }}>发布知识</button>
          {data.publication ? <ul className="learning-list" aria-label="本次发布结果"><PublicationResult result={data.publication} /></ul> : null}
        </div>
      </section>
    </div>
    <section className="settings-section" aria-label="知识发布核对"><header><div><b>知识发布核对</b><small>重新核对本项目的发布与恢复状态；可能推进已准备的发布，不代替新候选验证。</small></div></header>
      <div className="learning-detail"><button type="button" aria-label="核对知识发布" disabled={!available || !data.scope || busy} onClick={() => { void data.reconcile(); }}>核对知识发布</button>
        {data.reconciliation ? <><p>返回 {data.reconciliation.results.length} 项发布结果，{data.reconciliation.blocked.length} 项阻断。</p>
          <ul className="learning-list" aria-label="核对发布结果">{data.reconciliation.results.map((result, index) => <PublicationResult key={`${result.publication.key}:${index}`} result={result} />)}</ul>
          <ul aria-label="发布阻断项">{data.reconciliation.blocked.map((failure, index) => <li key={`${failure.code}:${index}`}>{failure.code}</li>)}</ul></> : null}
      </div>
    </section>
    <section className="settings-section" aria-label="学习任务"><header><div><b>学习任务</b><small>最多展示 100 项；读取任务不会启动提炼或模型。</small></div></header>
      {data.scope && !data.loading && !data.error && !data.jobs.length ? <p className="learning-note">暂无学习任务。</p> : null}
      <ul className="learning-list">{data.jobs.map(job => <li key={job.jobId}><b>{jobStates[job.status]}</b><code>{job.jobId}</code><small>尝试 {job.attemptCount} 次</small></li>)}</ul>
    </section>
  </section>;
}
