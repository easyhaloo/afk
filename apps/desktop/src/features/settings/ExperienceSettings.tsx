import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Search, Trash2 } from "lucide-react";
import { parseExperienceOutcomeQuery, type DesktopExperience, type DesktopExperienceOutcome } from "../../../shared/experience-contract.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { SshConfirmDialog } from "../ssh/SshConfirmDialog.js";
import "./plugins.css";

export function ExperienceSettings() {
  const [projects, setProjects] = useState<string[]>([]);
  const [scope, setScope] = useState("");
  const [records, setRecords] = useState<DesktopExperience[]>([]);
  const [prompt, setPrompt] = useState("");
  const [appliedPrompt, setAppliedPrompt] = useState("");
  const [selected, setSelected] = useState<DesktopExperience>();
  const [runId, setRunId] = useState("");
  const [action, setAction] = useState("");
  const [revoking, setRevoking] = useState<DesktopExperience>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [outcomeRunId, setOutcomeRunId] = useState("");
  const [outcomeWorkItemId, setOutcomeWorkItemId] = useState("");
  const [outcomes, setOutcomes] = useState<DesktopExperienceOutcome[]>([]);
  const [outcomeBusy, setOutcomeBusy] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");
  const [outcomeQueried, setOutcomeQueried] = useState(false);
  const outcomeRevision = useRef(0);
  const mounted = useRef(false);
  const revision = useRef(0);
  const changing = useRef(false);

  async function loadProjects() {
    setError("");
    try {
      const result = await window.afkDesktop.experiences.projects();
      if (mounted.current) { setProjects(result); setScope(current => result.includes(current) ? current : ""); }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "项目读取失败，请重试。"); }
  }

  async function load(project: string, query: string, mutation?: () => Promise<DesktopExperience>) {
    if (changing.current) return;
    const version = ++revision.current;
    changing.current = !!mutation;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mutation) await mutation();
      const result = await window.afkDesktop.experiences.list({ scope: project, ...(query ? { prompt: query } : {}) });
      if (mounted.current && version === revision.current) {
        setRecords(result);
        setAppliedPrompt(query);
        if (mutation) { setSelected(undefined); setMessage("经验状态已更新。"); }
      }
    } catch (failure) {
      if (mounted.current && version === revision.current) setError(failure instanceof Error ? failure.message : "经验操作失败，请重试。");
    } finally {
      if (mutation) changing.current = false;
      if (mounted.current && version === revision.current) setBusy(false);
    }
  }

  async function loadOutcomes() {
    if (!scope || outcomeBusy || busy) return;
    const version = ++outcomeRevision.current;
    setOutcomeBusy(true);
    setOutcomeError("");
    setOutcomes([]);
    setOutcomeQueried(false);
    try {
      const input = parseExperienceOutcomeQuery({ scope, runId: outcomeRunId.trim(), workItemId: outcomeWorkItemId });
      const result = await window.afkDesktop.experiences.outcomes({ scope: input.scope, runId: input.runId, workItemId: input.workItemId });
      if (mounted.current && version === outcomeRevision.current) { setOutcomes(result); setOutcomeQueried(true); }
    } catch (failure) {
      if (mounted.current && version === outcomeRevision.current) setOutcomeError(failure instanceof Error ? failure.message : "经验结果读取失败，请重试。");
    } finally {
      if (mounted.current && version === outcomeRevision.current) setOutcomeBusy(false);
    }
  }

  function invalidateOutcomes() {
    outcomeRevision.current++;
    setOutcomes([]); setOutcomeError(""); setOutcomeQueried(false); setOutcomeBusy(false);
  }

  useEffect(() => {
    mounted.current = true;
    void loadProjects();
    return () => { mounted.current = false; revision.current++; outcomeRevision.current++; };
  }, []);
  useEffect(() => {
    revision.current++;
    invalidateOutcomes(); setOutcomeRunId(""); setOutcomeWorkItemId("");
    setRecords([]); setSelected(undefined); setRevoking(undefined); setPrompt(""); setAppliedPrompt(""); setError(""); setMessage("");
    if (scope) void load(scope, "");
    else setBusy(false);
  }, [scope]);

  return <section className="settings-section plugin-settings" aria-label="经验管理" aria-busy={busy}>
    <header><div><b>经验管理</b><small>仅在选定项目中管理经验。召回仅返回未过期的已验证记录。</small></div><button type="button" aria-label="刷新经验" title="刷新项目与经验" disabled={busy} onClick={() => { void loadProjects(); if (scope) void load(scope, appliedPrompt); }}><RefreshCw size={16} /></button></header>
    <div className="plugin-install"><SelectMenu label="经验项目" placeholder="选择项目" value={scope} options={projects.map(project => ({ value: project, label: project }))} disabled={busy} onChange={setScope} search={{ label: "搜索经验项目" }} /></div>
    {!projects.length ? <p className="plugin-notice">暂无可用项目，请在工作项中配置并刷新来源。</p> : null}
    <form className="plugin-install" onSubmit={event => { event.preventDefault(); if (scope) void load(scope, prompt.trim()); }}>
      <label>召回内容<input aria-label="召回内容" value={prompt} maxLength={2000} disabled={!scope || busy} onChange={event => setPrompt(event.target.value)} placeholder="描述问题，留空列出全部状态" /></label>
      <button type="submit" aria-label="查询经验" title="查询经验" disabled={!scope || busy}><Search size={16} /></button>
    </form>
    {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
    {scope ? <p className="plugin-notice">{appliedPrompt ? "召回结果：仅已验证且未过期的相关经验" : "最近 100 条经验（全部状态）"}{busy ? " · 正在读取…" : records.length === 0 ? " · 没有匹配记录" : ""}</p> : null}
    <ul className="plugin-list">{records.map(record => <li key={record.id}>
      <div className="plugin-description"><b>{record.trigger}</b><small>{({ candidate: "待验证", verified: "已验证", revoked: "已撤销" })[record.status]} · {record.occurrences} 次 · 到期 {record.expiresAt}</small>
        <p>{record.rootCause}</p><p>{record.action}</p><small>来源：{record.source.workItemId} · {record.source.runId}</small><small>证据：{record.evidence.join(" · ")}</small>
        {record.verifiedEvidence ? <small>独立验证：{record.verifiedEvidence.runId} · {record.verifiedEvidence.evidence.join(" · ")}</small> : null}
      </div><div className="plugin-actions">
        <button type="button" aria-label={`验证 ${record.id}`} title="使用独立运行验证修正" disabled={busy || record.status === "revoked" || Date.parse(record.expiresAt) <= Date.now()} onClick={() => { setSelected(record); setRunId(""); setAction(""); }}><Check size={16} /></button>
        <button type="button" aria-label={`撤销 ${record.id}`} title="撤销经验" disabled={busy || record.status === "revoked"} onClick={() => setRevoking(record)}><Trash2 size={16} /></button>
      </div>
    </li>)}</ul>
    <section aria-label="经验结果收据" aria-busy={outcomeBusy}>
      <b>运行结果与复发记录</b>
      <p className="plugin-notice">按运行和规范工作项 ID 读取历史收据。成功或已选择不代表已采纳或产生收益；未记录复发不保证没有复发。</p>
      <form className="plugin-install" aria-label="查询经验结果" onSubmit={event => { event.preventDefault(); void loadOutcomes(); }}>
        <label>运行 ID<input aria-label="结果运行 ID" value={outcomeRunId} maxLength={512} disabled={!scope || busy || outcomeBusy} required onChange={event => { invalidateOutcomes(); setOutcomeRunId(event.target.value); }} /></label>
        <label>规范工作项 ID<input aria-label="结果工作项 ID" value={outcomeWorkItemId} maxLength={1024} placeholder={scope ? `${scope}#123` : "platform:project#123"} disabled={!scope || busy || outcomeBusy} required onChange={event => { invalidateOutcomes(); setOutcomeWorkItemId(event.target.value); }} /></label>
        <button type="submit" aria-label="提交结果查询" title="查询结果收据" disabled={!scope || busy || outcomeBusy || !outcomeRunId.trim() || !outcomeWorkItemId.trim()}><Search size={16} /></button>
      </form>
      {outcomeError ? <p role="alert">{outcomeError}</p> : null}
      {outcomeBusy ? <p className="plugin-notice" role="status">正在读取结果收据…</p> : outcomeQueried ? <p className="plugin-notice" role="status">{outcomes.length ? `结果收据 ${outcomes.length} 条（最多 20 条）` : "没有结果收据"}</p> : null}
      <ul className="plugin-list">{outcomes.map(receipt => <li key={`${receipt.experienceId}:${receipt.selectionId}:${receipt.event.sequence}`}>
        <div className="plugin-description">
          <b>{({ succeeded: "成功", failed: "失败", cancelled: "已取消" })[receipt.event.outcome]} · {receipt.recurrence ? "已记录复发" : "本收据未记录复发"} · 收益未知</b>
          <small>经验：{receipt.experienceId} · 选择：{receipt.selectionId}</small>
          <small>运行：{receipt.runId} · 工作项：{receipt.workItemId}</small>
          <small>事件：{receipt.event.type} · 序号 {receipt.event.sequence} · {receipt.event.occurredAt}</small>
          <small>记录时间：{receipt.recordedAt}</small>
          {receipt.publication ? <small>发布：{receipt.publication.key} · 候选 {receipt.publication.candidateId} · {`验证版本 ${receipt.publication.validatedVersion}`}</small> : null}
        </div>
      </li>)}</ul>
    </section>
    {selected ? <form className="plugin-install" aria-label="独立验证经验" onSubmit={event => { event.preventDefault(); void load(scope, appliedPrompt, () => window.afkDesktop.experiences.verify({ scope, id: selected.id, runId: runId.trim(), action: action.trim() })); }}>
      <p className="plugin-notice">{selected.trigger}：独立运行必须属于同一项目并已通过完整 QA。主进程检查审计完整性、运行结果和新证据；候选失败运行不能验证自身。</p>
      <label>独立验证运行<input aria-label="独立验证运行" value={runId} maxLength={512} disabled={busy} onChange={event => setRunId(event.target.value)} required /></label>
      <label>已验证修正<input aria-label="已验证修正" value={action} maxLength={4096} disabled={busy} onChange={event => setAction(event.target.value)} required /></label>
      <button type="submit" disabled={busy || !runId.trim() || !action.trim()}>验证并保存</button><button type="button" disabled={busy} onClick={() => setSelected(undefined)}>取消</button>
    </form> : null}
    {revoking ? <SshConfirmDialog title="撤销经验" description={`撤销「${revoking.trigger}」后将不再用于召回。保留来源及验证证据。`} confirmLabel="撤销" confirmAriaLabel="确认撤销经验" onCancel={() => setRevoking(undefined)} onConfirm={() => { const record = revoking; setRevoking(undefined); void load(scope, appliedPrompt, () => window.afkDesktop.experiences.revoke({ scope, id: record.id })); }} /> : null}
  </section>;
}
