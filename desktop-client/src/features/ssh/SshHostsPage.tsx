import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, Copy, KeyRound, Link2, Plus, RefreshCw, Search, Server, ShieldCheck, Trash2, X } from "lucide-react";
import type { ManagedSshHostInput, SshDiagnostic, SshExternalTerminalId, SshHost, SshHostSource, SshHostStatus, SshSession } from "../../../shared/ssh-contract";
import { groupSshDiagnostics, type GroupedSshDiagnostic } from "./ssh-diagnostics";
import "./ssh.css";

type SourceFilter = "all" | SshHostSource;
type StatusFilter = "all" | SshHostStatus;
type SshTerminalId = "builtin" | SshExternalTerminalId;
type TerminalResult = string | { terminal: SshExternalTerminalId };
const terminalLabels: Record<SshTerminalId, string> = { builtin: "内置终端", iterm2: "iTerm2", warp: "Warp", ghostty: "Ghostty", cmux: "cmux", terminal: "Terminal.app" };
const terminalOptions: Array<{ value: SshTerminalId; label: string }> = Object.entries(terminalLabels).map(([value, label]) => ({ value: value as SshTerminalId, label }));

const statusLabels: Record<SshHostStatus, string> = { ready: "可连接", untrusted: "待确认指纹", "key-missing": "缺少密钥", unreachable: "不可达", "auth-required": "需要免密", "identity-changed": "指纹异常", invalid: "配置异常" };
const sourceLabels: Record<SshHostSource, string> = { system: "系统配置", managed: "AFK 管理" };
const diagnosticTypeLabels: Record<string, string> = { "ssh.host-key-checking-disabled": "主机密钥校验已关闭", "ssh.known-hosts-disabled": "known_hosts 已禁用", "ssh.malformed-directive": "无法解析的配置行", "ssh.non-concrete-host": "非具体 Host" };
const diagnosticSeverityLabels: Record<SshDiagnostic["severity"], string> = { info: "提示", warning: "警告", error: "错误" };
const modalFocusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(modalFocusableSelector)).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

export function filterSshHosts(hosts: SshHost[], query: string, source: SourceFilter, status: StatusFilter) {
  const normalized = query.trim().toLowerCase();
  return hosts.filter((host) => {
    const matchesQuery = !normalized || [host.alias, host.hostname, host.user || ""].some((value) => value.toLowerCase().includes(normalized));
    return matchesQuery && (source === "all" || host.source === source) && (status === "all" || host.status === status);
  });
}

export function sshDiagnosticTypeLabel(code: string) {
  return diagnosticTypeLabels[code] || "配置诊断";
}

function terminalName(result: TerminalResult) {
  const terminal = typeof result === "string" ? result : result.terminal;
  return terminalLabels[terminal as SshTerminalId] || terminal;
}

function SshDiagnostics({ diagnostics, total }: { diagnostics: GroupedSshDiagnostic[]; total: number }) {
  return <section className="ssh-diagnostics" aria-label="SSH 配置提示">
    <header className="ssh-diagnostics-heading"><div><CircleAlert size={14} /><h2>SSH 配置提示</h2></div><span className="ssh-diagnostics-total">{total} 条</span></header>
    <ul className="ssh-diagnostic-list">{diagnostics.map((diagnostic) => <li className={`ssh-diagnostic-group ${diagnostic.severity}`} key={`${diagnostic.code}-${diagnostic.severity}-${diagnostic.message}-${diagnostic.path || ""}`}>
      <div className="ssh-diagnostic-group-header"><strong>{sshDiagnosticTypeLabel(diagnostic.code)}</strong><span className="ssh-diagnostic-severity">{diagnosticSeverityLabels[diagnostic.severity]}</span><span className="ssh-diagnostic-count">{diagnostic.count} 条</span></div>
      {diagnostic.path ? <code className="ssh-diagnostic-path">{diagnostic.path}</code> : null}
      {diagnostic.hostAliases.length ? <details className="ssh-diagnostic-hosts"><summary>查看受影响 Host</summary><div className="ssh-diagnostic-host-list">{diagnostic.hostAliases.map((alias) => <span className="ssh-diagnostic-host" key={alias}>{alias}</span>)}</div></details> : <p className="ssh-diagnostic-message">{diagnostic.message}</p>}
    </li>)}</ul>
  </section>;
}

type SshHostsPageProps = { onSession: (session: SshSession, publicKeyPath?: string) => void };

export function SshHostsPage({ onSession }: SshHostsPageProps) {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [diagnostics, setDiagnostics] = useState<SshDiagnostic[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [terminalId, setTerminalId] = useState<SshTerminalId>("builtin");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ManagedSshHostInput>({ alias: "", hostname: "", port: 22, user: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const modalRef = useRef<HTMLFormElement>(null);
  const addHostButtonRef = useRef<HTMLButtonElement>(null);

  const load = async () => {
    setBusy("list"); setError("");
    try {
      const result = await window.afkDesktop.ssh.list();
      setHosts(result.hosts); setDiagnostics(result.diagnostics);
      setSelectedId((current) => result.hosts.some((host) => host.id === current) ? current : result.hosts[0]?.id || "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };

  useEffect(() => { void load(); }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    addHostButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!formOpen) return;
    const modal = modalRef.current;
    if (!modal) return;
    getFocusableElements(modal)[0]?.focus();
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeForm();
    };
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown, true);
  }, [closeForm, formOpen]);

  const filtered = useMemo(() => filterSshHosts(hosts, query, source, status), [hosts, query, source, status]);
  const groupedDiagnostics = useMemo(() => groupSshDiagnostics(diagnostics), [diagnostics]);
  const selected = filtered.find((host) => host.id === selectedId) || filtered[0] || null;

  const run = async (label: string, action: () => Promise<unknown>, successMessage: string | ((result: unknown) => string) = "操作已完成") => {
    setBusy(label); setError(""); setNotice("");
    try {
      const result = await action();
      setNotice(typeof successMessage === "function" ? successMessage(result) : label === "test" ? "免密测试已完成" : successMessage);
      await load();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };

  const add = async () => {
    await run("add", async () => { const host = await window.afkDesktop.ssh.add({ ...form, user: form.user || undefined }); closeForm(); setForm({ alias: "", hostname: "", port: 22, user: "" }); setSelectedId(host.id); });
  };

  const trust = () => selected?.fingerprint ? void run("trust", async () => { await window.afkDesktop.ssh.trust({ hostId: selected.id, fingerprint: selected.fingerprint! }); }) : undefined;
  const test = () => selected ? void run("test", async () => { await window.afkDesktop.ssh.test(selected.id); }) : undefined;
  const connect = () => selected ? void run(terminalId === "builtin" ? "connect" : "external", async () => {
    if (terminalId === "builtin") {
      onSession(await window.afkDesktop.ssh.connect(selected.id));
      return undefined;
    }
    return window.afkDesktop.ssh.openExternal(selected.id, terminalId);
  }, (result) => result ? `已在 ${terminalName(result as TerminalResult)} 打开 ${selected.alias}` : "内置终端已打开") : undefined;
  const generate = () => void run("generate", async () => { const result = await window.afkDesktop.ssh.generateKey(); onSession(result.session, result.publicKeyPath); });
  const deploy = () => selected ? void run("deploy", async () => { onSession(await window.afkDesktop.ssh.deployKey(selected.id)); }) : undefined;
  const remove = () => selected && selected.source === "managed" && window.confirm(`删除 AFK SSH 主机“${selected.alias}”？`) ? void run("remove", async () => { await window.afkDesktop.ssh.remove(selected.id); }) : undefined;

  return <section className="control-page ssh-page" aria-label="SSH 主机管理">
    <header className="control-page-heading ssh-heading"><div><p>本地基础设施</p><h1>SSH 主机</h1><span>复用系统 OpenSSH 配置，在不托管私钥和密码的前提下管理远程连接。</span></div><div className="ssh-heading-actions"><button className="ssh-secondary-action" onClick={generate} disabled={!!busy}><KeyRound size={15} />生成 AFK 密钥</button><button ref={addHostButtonRef} className="ssh-primary-action" onClick={() => setFormOpen(true)}><Plus size={15} />添加主机</button></div></header>
    {error ? <div className="ssh-alert error" role="alert"><CircleAlert size={15} />{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div> : null}
    {notice ? <div className="ssh-alert success" role="status"><Check size={15} />{notice}</div> : null}
    {diagnostics.length ? <SshDiagnostics diagnostics={groupedDiagnostics} total={diagnostics.length} /> : null}
    <section className="ssh-toolbar"><label className="ssh-search"><Search size={15} /><input aria-label="搜索 SSH 主机" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索别名、地址或用户" /></label><select value={source} onChange={(event) => setSource(event.target.value as SourceFilter)} aria-label="来源筛选"><option value="all">全部来源</option><option value="system">系统配置</option><option value="managed">AFK 管理</option></select><select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} aria-label="状态筛选"><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="icon-button" onClick={() => void load()} disabled={!!busy} aria-label="刷新 SSH 主机"><RefreshCw size={16} className={busy === "list" ? "spin" : ""} /></button></section>
    <section className="ssh-layout"><div className="ssh-host-list">{filtered.length ? filtered.map((host) => <button className={`ssh-host-row${selected?.id === host.id ? " selected" : ""}`} key={host.id} onClick={() => setSelectedId(host.id)}><span className="ssh-host-icon"><Server size={16} /></span><span className="ssh-host-copy"><b>{host.alias}</b><small>{host.user ? `${host.user}@` : ""}{host.hostname}:{host.port}</small></span><span className={`ssh-status ${host.status}`}>{statusLabels[host.status]}</span><span className="ssh-source">{sourceLabels[host.source]}</span></button>) : <div className="ssh-empty"><Server size={24} /><b>{busy === "list" ? "正在读取 SSH 配置…" : "没有匹配的 SSH 主机"}</b><span>AFK 会读取 `~/.ssh/config`，并将新主机写入 `~/.ssh/afk_hosts`。</span></div>}</div><SshDetails host={selected} busy={busy} terminalId={terminalId} onTerminalChange={setTerminalId} onTrust={trust} onTest={test} onConnect={connect} onDeploy={deploy} onRemove={remove} /></section>
    {formOpen ? <div className="ssh-modal-backdrop"><form ref={modalRef} className="ssh-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-add-host-title" onKeyDown={(event) => { if (event.key !== "Tab") return; const focusableElements = getFocusableElements(event.currentTarget); if (!focusableElements.length) return; const firstFocusable = focusableElements[0]; const lastFocusable = focusableElements[focusableElements.length - 1]; if (event.shiftKey && document.activeElement === firstFocusable) { event.preventDefault(); lastFocusable.focus(); } else if (!event.shiftKey && document.activeElement === lastFocusable) { event.preventDefault(); firstFocusable.focus(); } }} onSubmit={(event) => { event.preventDefault(); void add(); }}><header><div><small>AFK 管理</small><h2 id="ssh-add-host-title">添加 SSH 主机</h2></div><button type="button" className="icon-button" onClick={closeForm} aria-label="关闭"><X size={16} /></button></header><label>Host 别名<input required value={form.alias} onChange={(event) => setForm({ ...form, alias: event.target.value })} placeholder="production-web" /></label><label>主机地址<input required value={form.hostname} onChange={(event) => setForm({ ...form, hostname: event.target.value })} placeholder="203.0.113.10" /></label><div className="ssh-form-row"><label>端口<input type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></label><label>用户<input value={form.user || ""} onChange={(event) => setForm({ ...form, user: event.target.value })} placeholder="deploy" /></label></div><label>已有私钥路径（可选）<input value={form.identityFile || ""} onChange={(event) => setForm({ ...form, identityFile: event.target.value || undefined })} placeholder="~/.ssh/id_ed25519" /></label><label>跳板机（可选）<input value={form.proxyJump || ""} onChange={(event) => setForm({ ...form, proxyJump: event.target.value || undefined })} placeholder="bastion" /></label><footer><button type="button" className="ssh-secondary-action" onClick={closeForm}>取消</button><button type="submit" className="ssh-primary-action" disabled={busy === "add"}>{busy === "add" ? "保存中…" : "保存主机"}</button></footer></form></div> : null}
  </section>;
}

function SshDetails({ host, busy, terminalId, onTerminalChange, onTrust, onTest, onConnect, onDeploy, onRemove }: { host: SshHost | null; busy: string; terminalId: SshTerminalId; onTerminalChange: (value: SshTerminalId) => void; onTrust: () => void; onTest: () => void; onConnect: () => void; onDeploy: () => void; onRemove: () => void }) {
  if (!host) return <aside className="ssh-details empty"><Server size={22} /><span>选择主机查看连接详情</span></aside>;
  const blocked = host.status === "identity-changed" || host.status === "invalid";
  return <aside className="ssh-details" aria-label={`${host.alias} SSH 详情`}><header><div className="ssh-details-heading-copy"><small>{sourceLabels[host.source]}</small><h2>{host.alias}</h2><span>{host.user ? `${host.user}@` : ""}{host.hostname}:{host.port}</span></div><span className={`ssh-status ${host.status}`}>{statusLabels[host.status]}</span></header><dl><div><dt>配置来源</dt><dd>{host.configPath}</dd></div><div><dt>HostName</dt><dd>{host.hostname}</dd></div><div><dt>IdentityFile</dt><dd>{host.identityFile || "系统默认密钥"}</dd></div><div><dt>ProxyJump</dt><dd>{host.proxyJump || "无"}</dd></div>{host.fingerprint ? <div><dt>主机指纹</dt><dd className="fingerprint">{host.fingerprint.algorithm} · {host.fingerprint.value}</dd></div> : null}</dl><div className="ssh-actions">{host.status === "untrusted" && host.fingerprint ? <button className="ssh-primary-action" onClick={onTrust} disabled={!!busy}><ShieldCheck size={15} />信任此指纹</button> : null}{host.status === "auth-required" ? <button className="ssh-secondary-action" onClick={onDeploy} disabled={!!busy}><Copy size={15} />部署公钥</button> : null}<button className="ssh-secondary-action" onClick={onTest} disabled={!!busy || blocked || host.status === "untrusted"}><Link2 size={15} />测试免密</button><div className="ssh-terminal-picker"><label htmlFor="ssh-terminal-select">终端</label><select id="ssh-terminal-select" aria-label="选择 SSH 终端" value={terminalId} onChange={(event) => onTerminalChange(event.target.value as SshTerminalId)} disabled={!!busy || blocked || host.status !== "ready"}>{terminalOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><button className="ssh-primary-action" onClick={onConnect} disabled={!!busy || blocked || host.status !== "ready"}>{busy === "connect" || busy === "external" ? "连接中…" : "连接"}</button></div>{host.source === "managed" ? <button className="ssh-danger-action" onClick={onRemove} disabled={!!busy}><Trash2 size={15} />删除</button> : null}</div>{busy === "connect" ? <p className="ssh-action-status" role="status" aria-live="polite">正在打开内置终端…</p> : null}{busy === "external" ? <p className="ssh-action-status" role="status" aria-live="polite">正在启动 {terminalLabels[terminalId]}…</p> : null}<p className="ssh-safety-note"><ShieldCheck size={14} />私钥、密码和终端输入由系统 OpenSSH 处理，AFK 不会保存。</p></aside>;
}
