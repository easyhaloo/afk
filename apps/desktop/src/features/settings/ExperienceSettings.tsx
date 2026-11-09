import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Search, Trash2 } from "lucide-react";
import type { DesktopExperience } from "../../../shared/experience-contract.js";
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

  useEffect(() => {
    mounted.current = true;
    void loadProjects();
    return () => { mounted.current = false; revision.current++; };
  }, []);
  useEffect(() => {
    revision.current++;
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
    {selected ? <form className="plugin-install" aria-label="独立验证经验" onSubmit={event => { event.preventDefault(); void load(scope, appliedPrompt, () => window.afkDesktop.experiences.verify({ scope, id: selected.id, runId: runId.trim(), action: action.trim() })); }}>
      <p className="plugin-notice">{selected.trigger}：独立运行必须属于同一项目并已通过完整 QA。主进程检查审计完整性、运行结果和新证据；候选失败运行不能验证自身。</p>
      <label>独立验证运行<input aria-label="独立验证运行" value={runId} maxLength={512} disabled={busy} onChange={event => setRunId(event.target.value)} required /></label>
      <label>已验证修正<input aria-label="已验证修正" value={action} maxLength={4096} disabled={busy} onChange={event => setAction(event.target.value)} required /></label>
      <button type="submit" disabled={busy || !runId.trim() || !action.trim()}>验证并保存</button><button type="button" disabled={busy} onClick={() => setSelected(undefined)}>取消</button>
    </form> : null}
    {revoking ? <SshConfirmDialog title="撤销经验" description={`撤销「${revoking.trigger}」后将不再用于召回。保留来源及验证证据。`} confirmLabel="撤销" confirmAriaLabel="确认撤销经验" onCancel={() => setRevoking(undefined)} onConfirm={() => { const record = revoking; setRevoking(undefined); void load(scope, appliedPrompt, () => window.afkDesktop.experiences.revoke({ scope, id: record.id })); }} /> : null}
  </section>;
}
