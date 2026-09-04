import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindowMac, Check, ChevronDown, CircleAlert, Command, Copy, Ghost, KeyRound, Link2, PanelsTopLeft, Plus, RefreshCw, Search, Server, ShieldCheck, SquareTerminal, Trash2, X, Zap, type LucideIcon } from "lucide-react";
import type { ManagedSshHostInput, SshDiagnostic, SshExternalTerminalId, SshHost, SshHostSource, SshHostStatus, SshSession } from "../../../shared/ssh-contract";
import { groupSshDiagnostics, type GroupedSshDiagnostic } from "./ssh-diagnostics";
import { fetchSshHostList, invalidateSshHostCache, isSshHostCacheFresh, readSshHostCache } from "./ssh-host-cache";
import { SshActionButton } from "./SshActionButton";
import "./ssh.css";

type SourceFilter = "all" | SshHostSource;
type StatusFilter = "all" | SshHostStatus;
type SshTerminalId = "builtin" | SshExternalTerminalId;
type TerminalResult = string | { terminal: SshExternalTerminalId };
const terminalLabels: Record<SshTerminalId, string> = { builtin: "内置终端", iterm2: "iTerm2", warp: "Warp", ghostty: "Ghostty", cmux: "cmux", terminal: "Terminal.app" };
const terminalOptions: Array<{ value: SshTerminalId; label: string }> = Object.entries(terminalLabels).map(([value, label]) => ({ value: value as SshTerminalId, label }));
const terminalIcons: Record<SshTerminalId, LucideIcon> = { builtin: SquareTerminal, iterm2: Command, warp: Zap, ghostty: Ghost, cmux: PanelsTopLeft, terminal: AppWindowMac };

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

function SshTerminalPicker({ value, disabled, onChange }: { value: SshTerminalId; disabled: boolean; onChange: (value: SshTerminalId) => void }) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(() => terminalOptions.findIndex((option) => option.value === value));
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = terminalOptions.find((option) => option.value === value) || terminalOptions[0];

  useEffect(() => {
    setHighlightedIndex(Math.max(0, terminalOptions.findIndex((option) => option.value === value)));
  }, [value]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return undefined;
    if (typeof document === "undefined") return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (typeof Node !== "undefined" && event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const choose = (option: { value: SshTerminalId }) => {
    onChange(option.value);
    setOpen(false);
  };

  const SelectedIcon = terminalIcons[selected.value];

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + terminalOptions.length) % terminalOptions.length);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(terminalOptions[highlightedIndex] || selected);
    }
  };

  return <div className="ssh-terminal-picker-control" ref={pickerRef}>
    <SshActionButton type="button" size="md" className="ssh-terminal-trigger" aria-label="选择 SSH 终端" aria-haspopup="listbox" aria-expanded={open} aria-controls="ssh-terminal-options" disabled={disabled} onClick={() => setOpen((current) => !current)} onKeyDown={handleKeyDown}>
      <span className="ssh-terminal-trigger-copy"><span className="ssh-terminal-icon ssh-terminal-icon-selected"><SelectedIcon size={16} strokeWidth={2.2} aria-hidden="true" /></span><span><small>终端</small><b>{selected.label}</b></span></span><ChevronDown className={open ? "ssh-terminal-chevron-open" : undefined} size={16} aria-hidden="true" />
    </SshActionButton>
    {open ? <div id="ssh-terminal-options" className="ssh-terminal-options" role="listbox" aria-label="选择 SSH 终端">
      {terminalOptions.map((option, index) => {
        const Icon = terminalIcons[option.value];
        return <button type="button" role="option" aria-selected={option.value === value} data-highlighted={index === highlightedIndex} data-terminal-id={option.value} key={option.value} onMouseEnter={() => setHighlightedIndex(index)} onClick={() => choose(option)}>
          <span className="ssh-terminal-option-copy"><span className={`ssh-terminal-icon ssh-terminal-icon-${option.value}`}><Icon size={16} strokeWidth={2.2} aria-hidden="true" /></span><span><b>{option.label}</b><small>{option.value === "builtin" ? "AFK 内置 SSH 会话" : "在本机应用中打开"}</small></span></span>{option.value === value ? <Check size={16} aria-hidden="true" /> : null}
        </button>;
      })}
    </div> : null}
  </div>;
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
  const [hosts, setHosts] = useState<SshHost[]>(() => readSshHostCache()?.result.hosts ?? []);
  const [diagnostics, setDiagnostics] = useState<SshDiagnostic[]>(() => readSshHostCache()?.result.diagnostics ?? []);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [terminalId, setTerminalId] = useState<SshTerminalId>("builtin");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ManagedSshHostInput>({ alias: "", hostname: "", port: 22, user: "" });
  const [addPassword, setAddPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const modalRef = useRef<HTMLFormElement>(null);
  const addHostButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const credentialGenerationRef = useRef(0);
  const [credentialStatus, setCredentialStatus] = useState<"loading" | "saved" | "missing" | "error">("loading");
  const [credentialRetryNonce, setCredentialRetryNonce] = useState(0);
  const [deploymentPassword, setDeploymentPassword] = useState("");
  const selectedHostIdRef = useRef("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  const load = useCallback(async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
    const generation = ++loadGenerationRef.current;
    const isCurrentRequest = () => mountedRef.current && loadGenerationRef.current === generation;
    if (isCurrentRequest()) { setBusy("list"); setError(""); }
    try {
      const result = await fetchSshHostList((options) => window.afkDesktop.ssh.list(options), { forceRefresh });
      if (!isCurrentRequest()) return;
      setHosts(result.hosts); setDiagnostics(result.diagnostics);
      setSelectedId((current) => result.hosts.some((host) => host.id === current) ? current : result.hosts[0]?.id || "");
    } catch (cause) {
      if (isCurrentRequest()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentRequest()) setBusy("");
    }
  }, []);

  useEffect(() => {
    const cached = readSshHostCache();
    if (!cached || !isSshHostCacheFresh(cached)) void load();
  }, [load]);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setAddPassword("");
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
  selectedHostIdRef.current = selected?.id || "";

  useEffect(() => {
    const hostId = selected?.id;
    const generation = ++credentialGenerationRef.current;
    setDeploymentPassword("");
    setBusy((current) => current === "credentials" ? "" : current);
    setError("");
    setNotice("");
    if (!hostId) {
      setCredentialStatus("missing");
      return () => { credentialGenerationRef.current += 1; };
    }
    setCredentialStatus("loading");
    void window.afkDesktop.ssh.credentialHas(hostId).then((saved) => {
      if (mountedRef.current && credentialGenerationRef.current === generation) setCredentialStatus(saved ? "saved" : "missing");
    }).catch((cause) => {
      if (mountedRef.current && credentialGenerationRef.current === generation) {
        setCredentialStatus("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => { credentialGenerationRef.current += 1; };
  }, [selected?.id, credentialRetryNonce]);

  const retryCredentialStatus = () => {
    if (!selected?.id) return;
    setCredentialStatus("loading");
    setError("");
    setNotice("");
    setCredentialRetryNonce((current) => current + 1);
  };

  const run = async (label: string, action: () => Promise<unknown>, successMessage: string | ((result: unknown) => string) = "操作已完成", refresh = false) => {
    setBusy(label); setError(""); setNotice("");
    try {
      const result = await action();
      setNotice(typeof successMessage === "function" ? successMessage(result) : label === "test" ? "免密测试已完成" : successMessage);
      if (refresh) {
        invalidateSshHostCache();
        await load({ forceRefresh: true });
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };

  const add = async () => {
    await run("add", async () => {
      const host = await window.afkDesktop.ssh.add({ ...form, user: form.user || undefined });
      if (addPassword.trim()) {
        try {
          await window.afkDesktop.ssh.credentialSet({ hostId: host.id, password: addPassword });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`主机已保存，但部署密码保存失败：${message}`);
        }
      }
      closeForm();
      setForm({ alias: "", hostname: "", port: 22, user: "" });
      setSelectedId(host.id);
    }, "操作已完成", true);
  };

  const trust = () => selected?.fingerprint ? void run("trust", async () => { await window.afkDesktop.ssh.trust({ hostId: selected.id, fingerprint: selected.fingerprint! }); }, "操作已完成", true) : undefined;
  const test = () => selected ? void run("test", async () => { await window.afkDesktop.ssh.test(selected.id); }, "操作已完成", true) : undefined;
  const connect = () => selected ? void run(terminalId === "builtin" ? "connect" : "external", async () => {
    if (terminalId === "builtin") {
      onSession(await window.afkDesktop.ssh.connect(selected.id));
      return undefined;
    }
    return window.afkDesktop.ssh.openExternal(selected.id, terminalId);
  }, (result) => result ? `已在 ${terminalName(result as TerminalResult)} 打开 ${selected.alias}` : "内置终端已打开") : undefined;
  const generate = () => void run("generate", async () => { const result = await window.afkDesktop.ssh.generateKey(); onSession(result.session, result.publicKeyPath); });
  const deploy = () => selected ? void run("deploy", async () => { onSession(await window.afkDesktop.ssh.deployKey(selected.id)); }, "操作已完成", true) : undefined;
  const remove = () => selected && selected.source === "managed" && window.confirm(`删除 AFK SSH 主机“${selected.alias}”？`) ? void run("remove", async () => { await window.afkDesktop.ssh.remove(selected.id); }, "操作已完成", true) : undefined;
  const saveDeploymentPassword = () => {
    const hostId = selected?.id;
    if (!hostId) return;
    if (!deploymentPassword.trim()) {
      setError("密码不能为空");
      setNotice("");
      return;
    }
    const generation = ++credentialGenerationRef.current;
    const isCurrentOperation = () => mountedRef.current && credentialGenerationRef.current === generation && selectedHostIdRef.current === hostId;
    void (async () => {
      setBusy("credentials"); setError(""); setNotice("");
      try {
        await window.afkDesktop.ssh.credentialSet({ hostId, password: deploymentPassword });
        const saved = await window.afkDesktop.ssh.credentialHas(hostId);
        if (isCurrentOperation()) {
          setCredentialStatus(saved ? "saved" : "missing");
          setDeploymentPassword("");
          setNotice("部署密码已保存");
        }
      } catch (cause) {
        if (isCurrentOperation()) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (isCurrentOperation()) setBusy("");
      }
    })();
  };
  const removeDeploymentPassword = () => {
    const hostId = selected?.id;
    if (!hostId) return;
    const generation = ++credentialGenerationRef.current;
    const isCurrentOperation = () => mountedRef.current && credentialGenerationRef.current === generation && selectedHostIdRef.current === hostId;
    void (async () => {
      setBusy("credentials"); setError(""); setNotice("");
      try {
        await window.afkDesktop.ssh.credentialRemove(hostId);
        const saved = await window.afkDesktop.ssh.credentialHas(hostId);
        if (isCurrentOperation()) {
          setCredentialStatus(saved ? "saved" : "missing");
          setDeploymentPassword("");
          setNotice("已删除部署密码");
        }
      } catch (cause) {
        if (isCurrentOperation()) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (isCurrentOperation()) setBusy("");
      }
    })();
  };

  return <section className="control-page ssh-page" aria-label="SSH 主机管理">
    <header className="control-page-heading ssh-heading"><div><p>本地基础设施</p><h1>SSH 主机</h1><span>复用系统 OpenSSH 配置，在不托管私钥和密码的前提下管理远程连接。</span></div><div className="ssh-heading-actions"><SshActionButton size="md" variant="secondary" onClick={generate} disabled={!!busy}><KeyRound size={15} />生成 AFK 密钥</SshActionButton><SshActionButton ref={addHostButtonRef} size="md" variant="primary" onClick={() => setFormOpen(true)}><Plus size={15} />添加主机</SshActionButton></div></header>
    {error ? <div className="ssh-alert error" role="alert"><CircleAlert size={15} />{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div> : null}
    {notice ? <div className="ssh-alert success" role="status"><Check size={15} />{notice}</div> : null}
    {diagnostics.length ? <SshDiagnostics diagnostics={groupedDiagnostics} total={diagnostics.length} /> : null}
    <section className="ssh-toolbar"><label className="ssh-search"><Search size={15} /><input aria-label="搜索 SSH 主机" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索别名、地址或用户" /></label><select value={source} onChange={(event) => setSource(event.target.value as SourceFilter)} aria-label="来源筛选"><option value="all">全部来源</option><option value="system">系统配置</option><option value="managed">AFK 管理</option></select><select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} aria-label="状态筛选"><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="icon-button" onClick={() => void load({ forceRefresh: true })} disabled={!!busy} aria-label="刷新 SSH 主机"><RefreshCw size={16} className={busy === "list" ? "spin" : ""} /></button></section>
    <section className="ssh-layout"><div className="ssh-host-list">{filtered.length ? filtered.map((host) => <button className={`ssh-host-row${selected?.id === host.id ? " selected" : ""}`} key={host.id} onClick={() => setSelectedId(host.id)}><span className="ssh-host-icon"><Server size={16} /></span><span className="ssh-host-copy"><b>{host.alias}</b><small>{host.user ? `${host.user}@` : ""}{host.hostname}:{host.port}</small></span><span className={`ssh-status ${host.status}`}>{statusLabels[host.status]}</span><span className="ssh-source">{sourceLabels[host.source]}</span></button>) : <div className="ssh-empty"><Server size={24} /><b>{busy === "list" ? "正在读取 SSH 配置…" : "没有匹配的 SSH 主机"}</b><span>AFK 会读取 `~/.ssh/config`，并将新主机写入 `~/.ssh/afk_hosts`。</span></div>}</div><SshDetails host={selected} busy={busy} terminalId={terminalId} credentialStatus={credentialStatus} deploymentPassword={deploymentPassword} onTerminalChange={setTerminalId} onPasswordChange={setDeploymentPassword} onSavePassword={saveDeploymentPassword} onRemovePassword={removeDeploymentPassword} onRetryPasswordStatus={retryCredentialStatus} onTrust={trust} onTest={test} onConnect={connect} onDeploy={deploy} onRemove={remove} /></section>
    {formOpen ? <div className="ssh-modal-backdrop"><form ref={modalRef} className="ssh-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-add-host-title" onKeyDown={(event) => { if (event.key !== "Tab") return; const focusableElements = getFocusableElements(event.currentTarget); if (!focusableElements.length) return; const firstFocusable = focusableElements[0]; const lastFocusable = focusableElements[focusableElements.length - 1]; if (event.shiftKey && document.activeElement === firstFocusable) { event.preventDefault(); lastFocusable.focus(); } else if (!event.shiftKey && document.activeElement === lastFocusable) { event.preventDefault(); firstFocusable.focus(); } }} onSubmit={(event) => { event.preventDefault(); void add(); }}><header><div><small>AFK 管理</small><h2 id="ssh-add-host-title">添加 SSH 主机</h2></div><button type="button" className="icon-button" onClick={closeForm} aria-label="关闭"><X size={16} /></button></header><label>Host 别名<input required value={form.alias} onChange={(event) => setForm({ ...form, alias: event.target.value })} placeholder="production-web" /></label><label>主机地址<input required value={form.hostname} onChange={(event) => setForm({ ...form, hostname: event.target.value })} placeholder="203.0.113.10" /></label><div className="ssh-form-row"><label>端口<input type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></label><label>用户<input value={form.user || ""} onChange={(event) => setForm({ ...form, user: event.target.value })} placeholder="deploy" /></label></div><label>部署密码（可选）<input type="password" autoComplete="new-password" aria-label="添加主机部署密码" value={addPassword} onChange={(event) => setAddPassword(event.target.value)} placeholder="用于首次部署公钥，保存到系统安全存储" /></label><label>已有私钥路径（可选）<input value={form.identityFile || ""} onChange={(event) => setForm({ ...form, identityFile: event.target.value || undefined })} placeholder="~/.ssh/id_ed25519" /></label><label>跳板机（可选）<input value={form.proxyJump || ""} onChange={(event) => setForm({ ...form, proxyJump: event.target.value || undefined })} placeholder="bastion" /></label><footer><SshActionButton size="md" variant="secondary" type="button" onClick={closeForm}>取消</SshActionButton><SshActionButton size="md" variant="primary" type="submit" disabled={busy === "add"}>{busy === "add" ? "保存中…" : "保存主机"}</SshActionButton></footer></form></div> : null}
  </section>;
}

function SshDetails({ host, busy, terminalId, credentialStatus, deploymentPassword, onTerminalChange, onPasswordChange, onSavePassword, onRemovePassword, onRetryPasswordStatus, onTrust, onTest, onConnect, onDeploy, onRemove }: { host: SshHost | null; busy: string; terminalId: SshTerminalId; credentialStatus: "loading" | "saved" | "missing" | "error"; deploymentPassword: string; onTerminalChange: (value: SshTerminalId) => void; onPasswordChange: (value: string) => void; onSavePassword: () => void; onRemovePassword: () => void; onRetryPasswordStatus: () => void; onTrust: () => void; onTest: () => void; onConnect: () => void; onDeploy: () => void; onRemove: () => void }) {
  if (!host) return <aside className="ssh-details empty"><Server size={22} /><span>选择主机查看连接详情</span></aside>;
  const blocked = host.status === "identity-changed" || host.status === "invalid";
  return <aside className="ssh-details" aria-label={`${host.alias} SSH 详情`}><header><div className="ssh-details-heading-copy"><small>{sourceLabels[host.source]}</small><h2>{host.alias}</h2><span>{host.user ? `${host.user}@` : ""}{host.hostname}:{host.port}</span></div><span className={`ssh-status ${host.status}`}>{statusLabels[host.status]}</span></header><dl><div><dt>配置来源</dt><dd>{host.configPath}</dd></div><div><dt>HostName</dt><dd>{host.hostname}</dd></div><div><dt>IdentityFile</dt><dd>{host.identityFile || "系统默认密钥"}</dd></div><div><dt>ProxyJump</dt><dd>{host.proxyJump || "无"}</dd></div>{host.fingerprint ? <div><dt>主机指纹</dt><dd className="fingerprint">{host.fingerprint.algorithm} · {host.fingerprint.value}</dd></div> : null}</dl><section className="ssh-credential-panel" aria-label="部署密码"><header><div><strong>部署密码</strong><small>用于首次部署公钥</small></div><span className={`ssh-credential-status ${credentialStatus}`}>{credentialStatus === "saved" ? "已保存" : credentialStatus === "loading" ? "读取中…" : credentialStatus === "error" ? "读取失败" : "未设置"}</span></header><label htmlFor={`ssh-deployment-password-${host.id}`}>密码<input id={`ssh-deployment-password-${host.id}`} type="password" required autoComplete="new-password" value={deploymentPassword} onChange={(event) => onPasswordChange(event.target.value)} placeholder="输入后保存到系统安全存储" /></label><div className="ssh-credential-actions"><SshActionButton size="md" variant="secondary" onClick={onSavePassword} disabled={!!busy || credentialStatus === "loading"}>{credentialStatus === "saved" ? "更新部署密码" : "保存部署密码"}</SshActionButton>{credentialStatus === "saved" ? <SshActionButton size="md" variant="danger" onClick={onRemovePassword} disabled={!!busy}>删除已保存密码</SshActionButton> : null}{credentialStatus === "error" ? <SshActionButton size="md" variant="secondary" onClick={onRetryPasswordStatus} disabled={!!busy}>重试读取</SshActionButton> : null}</div></section><div className="ssh-actions">{host.status === "untrusted" && host.fingerprint ? <SshActionButton size="md" variant="primary" className="ssh-trust-action" onClick={onTrust} disabled={!!busy}><ShieldCheck size={15} />信任此指纹</SshActionButton> : null}{host.status === "auth-required" && !blocked ? <SshActionButton size="md" variant="secondary" className="ssh-deploy-action" onClick={onDeploy} disabled={!!busy}><Copy size={15} />部署公钥</SshActionButton> : null}<div className="ssh-connection-actions"><SshActionButton size="md" variant="secondary" className="ssh-test-action" onClick={onTest} disabled={!!busy || blocked || host.status === "untrusted"}><Link2 size={15} />测试免密</SshActionButton><div className="ssh-terminal-picker"><SshTerminalPicker value={terminalId} onChange={onTerminalChange} disabled={!!busy || blocked || host.status !== "ready"} /><SshActionButton size="md" variant="primary" className="ssh-connect-action" onClick={onConnect} disabled={!!busy || blocked || host.status !== "ready"}>{busy === "connect" || busy === "external" ? "连接中…" : "连接"}</SshActionButton></div></div>{host.source === "managed" ? <SshActionButton size="md" variant="danger" onClick={onRemove} disabled={!!busy}><Trash2 size={15} />删除</SshActionButton> : null}</div>{busy === "connect" ? <p className="ssh-action-status" role="status" aria-live="polite">正在打开内置终端…</p> : null}{busy === "external" ? <p className="ssh-action-status" role="status" aria-live="polite">正在启动 {terminalLabels[terminalId]}…</p> : null}<p className="ssh-safety-note"><ShieldCheck size={14} />部署密码仅显示保存状态，并由系统安全存储保护；不会出现在终端、日志或 Host 列表中。</p></aside>;
}
