import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindowMac, Check, ChevronDown, CircleAlert, Command, Copy, Ghost, KeyRound, Link2, PanelsTopLeft, Plus, RefreshCw, Search, Server, ShieldCheck, SquareTerminal, Upload, X, Zap, type LucideIcon } from "lucide-react";
import type { ManagedSshHostInput, SshBastion, SshBastionAssetPreview, SshBastionSyncResult, SshDiagnostic, SshExternalTerminalId, SshHost, SshHostSource, SshHostStatus, SshJumpHostType, SshSession } from "../../../shared/ssh-contract";
import { groupSshDiagnostics, type GroupedSshDiagnostic } from "./ssh-diagnostics";
import { fetchSshHostList, invalidateSshHostCache, isSshHostCacheFresh, readSshHostCache } from "./ssh-host-cache";
import { AddBastionDialog } from "./AddBastionDialog";
import { JumpserverBastionCard } from "./JumpserverBastionCard";
import { JumpserverDetail } from "./JumpserverDetail";
import { SshActionButton } from "./SshActionButton";
import { SshConfirmDialog } from "./SshConfirmDialog";
import "./ssh.css";

type SourceFilter = "all" | SshHostSource;
type StatusFilter = "all" | SshHostStatus;
type BastionFilter = "all" | "bastion" | "direct";
type SshTerminalId = "builtin" | SshExternalTerminalId;
type TerminalResult = string | { terminal: SshExternalTerminalId };
const terminalLabels: Record<SshTerminalId, string> = { builtin: "内置终端", iterm2: "iTerm2", warp: "Warp", ghostty: "Ghostty", cmux: "cmux", terminal: "Terminal.app" };
const terminalOptions: Array<{ value: SshTerminalId; label: string }> = Object.entries(terminalLabels).map(([value, label]) => ({ value: value as SshTerminalId, label }));
const terminalIcons: Record<SshTerminalId, LucideIcon> = { builtin: SquareTerminal, iterm2: Command, warp: Zap, ghostty: Ghost, cmux: PanelsTopLeft, terminal: AppWindowMac };
const jumpHostTypeLabels: Record<"none" | SshJumpHostType, string> = { none: "不使用跳板机", openssh: "OpenSSH ProxyJump", jumpserver: "JumpServer" };

const statusLabels: Record<SshHostStatus, string> = { ready: "可连接", untrusted: "待确认指纹", "key-missing": "缺少密钥", unreachable: "不可达", "auth-required": "需要免密", "identity-changed": "指纹异常", invalid: "配置异常" };
const sourceLabels: Record<SshHostSource, string> = { system: "系统配置", managed: "AFK 管理" };
const diagnosticTypeLabels: Record<string, string> = { "ssh.host-key-checking-disabled": "主机密钥校验已关闭", "ssh.known-hosts-disabled": "known_hosts 已禁用", "ssh.malformed-directive": "无法解析的配置行", "ssh.non-concrete-host": "非具体 Host" };
const diagnosticSeverityLabels: Record<SshDiagnostic["severity"], string> = { info: "提示", warning: "警告", error: "错误" };
const modalFocusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

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

export function nextSshHostAlias(alias: string, hosts: SshHost[]) {
  const baseAlias = `${alias}-copy`;
  const aliases = new Set(hosts.map((host) => host.alias));
  if (!aliases.has(baseAlias)) return baseAlias;
  let suffix = 2;
  while (aliases.has(`${baseAlias}-${suffix}`)) suffix += 1;
  return `${baseAlias}-${suffix}`;
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
    <SshActionButton type="button" size="sm" className="ssh-terminal-trigger" aria-label="选择 SSH 终端" aria-haspopup="listbox" aria-expanded={open} aria-controls="ssh-terminal-options" disabled={disabled} onClick={() => setOpen((current) => !current)} onKeyDown={handleKeyDown}>
      <span className="ssh-terminal-trigger-copy"><span className="ssh-terminal-icon ssh-terminal-icon-selected"><SelectedIcon size={16} strokeWidth={2.2} aria-hidden="true" /></span><span><small>终端</small><b>{selected.label}</b></span></span><ChevronDown className={open ? "ssh-terminal-chevron-open" : undefined} size={16} aria-hidden="true" />
    </SshActionButton>
    {open ? <div id="ssh-terminal-options" className="ssh-terminal-options" role="listbox" aria-label="选择 SSH 终端" data-placement="start">
      {terminalOptions.map((option, index) => {
        const Icon = terminalIcons[option.value];
        return <button type="button" role="option" aria-selected={option.value === value} data-highlighted={index === highlightedIndex} data-terminal-id={option.value} key={option.value} onMouseEnter={() => setHighlightedIndex(index)} onClick={() => choose(option)}>
          <span className="ssh-terminal-option-copy"><span className={`ssh-terminal-icon ssh-terminal-option-icon ssh-terminal-icon-${option.value}`} data-terminal-icon={option.value}><Icon size={16} strokeWidth={2.2} aria-hidden="true" /></span><span><b>{option.label}</b><small>{option.value === "builtin" ? "AFK 内置 SSH 会话" : "在本机应用中打开"}</small></span></span>{option.value === value ? <Check size={16} aria-hidden="true" /> : null}
        </button>;
      })}
    </div> : null}
  </div>;
}

type SshFormPickerOption = { value: string; label: string; description?: string };

export function SshFormPicker({ id, ariaLabel, value, options, placeholder, required, disabled = false, onChange }: { id: string; ariaLabel: string; value: string; options: SshFormPickerOption[]; placeholder: string; required?: boolean; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const pickerDisabled = disabled || options.length === 0;

  useEffect(() => {
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [selectedIndex, options.length]);

  useEffect(() => {
    if (pickerDisabled) setOpen(false);
  }, [pickerDisabled]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (typeof Node !== "undefined" && event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const choose = (option: SshFormPickerOption) => {
    if (pickerDisabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (pickerDisabled) return;
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const nextIndex = (highlightedIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setHighlightedIndex(nextIndex);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(options[highlightedIndex] || options[0]);
    }
  };

  return <div className="ssh-form-picker" ref={pickerRef}>
    <button type="button" id={id} className="ssh-form-picker-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-options`} aria-required={required} disabled={pickerDisabled} onClick={() => setOpen((current) => !current)} onKeyDown={handleKeyDown}>
      <span>{selected?.label || placeholder}</span><ChevronDown className={open ? "ssh-form-picker-chevron-open" : undefined} size={16} aria-hidden="true" />
    </button>
    {open ? <div id={`${id}-options`} className="ssh-form-picker-options" role="listbox" aria-label={ariaLabel}>
      {options.map((option, index) => <button type="button" role="option" aria-selected={option.value === value} data-highlighted={index === highlightedIndex} key={option.value || "empty"} onMouseEnter={() => setHighlightedIndex(index)} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); choose(option); }} onClick={(event) => event?.stopPropagation()}><span><b>{option.label}</b>{option.description ? <small>{option.description}</small> : null}</span>{option.value === value ? <Check size={15} aria-hidden="true" /> : null}</button>)}
    </div> : null}
  </div>;
}

function SshDiagnostics({ diagnostics, total }: { diagnostics: GroupedSshDiagnostic[]; total: number }) {
  const [open, setOpen] = useState(false);

  return <section className="ssh-diagnostics" aria-label="SSH 配置提示">
    <button type="button" className="ssh-diagnostics-toggle" aria-expanded={open} aria-controls="ssh-diagnostics-content" onClick={() => setOpen((current) => !current)}>
      <span className="ssh-diagnostics-heading"><span className="ssh-diagnostics-heading-copy"><CircleAlert size={14} /><span>SSH 配置提示</span></span><span className="ssh-diagnostics-total">{total} 条</span><ChevronDown className="ssh-diagnostics-chevron" size={15} aria-hidden="true" /></span>
    </button>
    {open ? <ul id="ssh-diagnostics-content" className="ssh-diagnostic-list">{diagnostics.map((diagnostic) => <li className={`ssh-diagnostic-group ${diagnostic.severity}`} key={`${diagnostic.code}-${diagnostic.severity}-${diagnostic.message}-${diagnostic.path || ""}`}>
      <div className="ssh-diagnostic-group-header"><strong>{sshDiagnosticTypeLabel(diagnostic.code)}</strong><span className="ssh-diagnostic-severity">{diagnosticSeverityLabels[diagnostic.severity]}</span><span className="ssh-diagnostic-count">{diagnostic.count} 条</span></div>
      {diagnostic.path ? <code className="ssh-diagnostic-path">{diagnostic.path}</code> : null}
      {diagnostic.hostAliases.length ? <details className="ssh-diagnostic-hosts"><summary>查看受影响 Host</summary><div className="ssh-diagnostic-host-list">{diagnostic.hostAliases.map((alias) => <span className="ssh-diagnostic-host" key={alias}>{alias}</span>)}</div></details> : <p className="ssh-diagnostic-message">{diagnostic.message}</p>}
    </li>)}</ul> : null}
  </section>;
}

function SshHostRow({ host, selected, busy, onSelect, onEdit, onCopy, onRemove }: { host: SshHost; selected: boolean; busy: string; onSelect: () => void; onEdit: (host: SshHost) => void; onCopy: (host: SshHost) => void; onRemove: (host: SshHost) => void }) {
  const canRemove = host.source === "managed" || host.status === "unreachable";
  const removeLabel = host.source === "managed" ? `删除 SSH 主机 ${host.alias}` : `清理不可达 SSH 主机 ${host.alias}`;
  return <div className={`ssh-host-row${selected ? " selected" : ""}`} onClick={onSelect} onDoubleClick={() => { if (host.source === "managed") onEdit(host); }}>
    <button type="button" className="ssh-host-select" aria-label={`查看 ${host.alias} SSH 详情`} onClick={onSelect}>
      <span className="ssh-host-icon"><Server size={16} /></span>
      <span className="ssh-host-copy"><b>{host.alias}</b><small>{host.user ? `${host.user}@` : ""}{host.hostname}:{host.port}</small></span>
      <span className={`ssh-status ${host.status}`}>{statusLabels[host.status]}</span>
      <span className="ssh-source">{sourceLabels[host.source]}</span>
    </button>
    <SshActionButton type="button" size="sm" variant="secondary" className="ssh-host-copy-action" aria-label={`复制 SSH 主机 ${host.alias}`} title="复制主机" onClick={(event) => { event?.stopPropagation(); onCopy(host); }} disabled={!!busy}><Copy size={15} aria-hidden="true" /></SshActionButton>
    {canRemove ? <SshActionButton type="button" size="sm" variant="danger" className="ssh-host-delete" aria-label={removeLabel} title={host.source === "managed" ? "删除主机" : "清理不可达配置"} onClick={(event) => { event?.stopPropagation(); onRemove(host); }} disabled={!!busy}><X size={15} aria-hidden="true" /></SshActionButton> : null}
  </div>;
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
  const [editingHostId, setEditingHostId] = useState("");
  const [copyingHostId, setCopyingHostId] = useState("");
  const [form, setForm] = useState<ManagedSshHostInput>({ alias: "", hostname: "", port: 22, user: "", jumpHostType: "none" });
  const [addPassword, setAddPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<SshHost | null>(null);
  const [bastions, setBastions] = useState<SshBastion[]>([]);
  const [selectedBastionId, setSelectedBastionId] = useState("");
  const [collapsedBastions, setCollapsedBastions] = useState<Set<string>>(new Set());
  const [syncLogs, setSyncLogs] = useState<Record<string, import("../../../shared/ssh-contract").SshBastionSyncLogEntry[]>>({});
  const [bastionFilter, setBastionFilter] = useState<BastionFilter>("all");
  const [pendingBastionRemoval, setPendingBastionRemoval] = useState<SshBastion | null>(null);
  const [addBastionOpen, setAddBastionOpen] = useState(false);
  const [bastionAddAlias, setBastionAddAlias] = useState("");
  const [bastionAddHost, setBastionAddHost] = useState("");
  const [bastionAddPort, setBastionAddPort] = useState(2222);
  const [bastionAddUser, setBastionAddUser] = useState("");
  const [bastionAddPassword, setBastionAddPassword] = useState("");
  const [bastionAddOtp, setBastionAddOtp] = useState("");
  const [bastionAddLinuxOnly, setBastionAddLinuxOnly] = useState(true);
  const [bastionTestState, setBastionTestState] = useState<"idle" | "testing" | "preview" | "error">("idle");
  const [bastionTestError, setBastionTestError] = useState("");
  const [bastionPreview, setBastionPreview] = useState<SshBastionAssetPreview[]>([]);
  const [bastionCurrentBastionId, setBastionCurrentBastionId] = useState("");
  const [bastionSelectedNames, setBastionSelectedNames] = useState<Set<string>>(new Set());
  const [bastionSyncing, setBastionSyncing] = useState(false);
  const [bastionSyncError, setBastionSyncError] = useState("");
  const [bastionSyncResult, setBastionSyncResult] = useState<SshBastionSyncResult | undefined>();
  const modalRef = useRef<HTMLFormElement>(null);
  const addHostButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  const load = useCallback(async ({ forceRefresh = false, background = false }: { forceRefresh?: boolean; background?: boolean } = {}) => {
    const generation = ++loadGenerationRef.current;
    const isCurrentRequest = () => mountedRef.current && loadGenerationRef.current === generation;
    if (isCurrentRequest()) { if (!background) setBusy("list"); setError(""); }
    try {
      const result = await fetchSshHostList((options) => window.afkDesktop.ssh.list(options), { forceRefresh });
      if (!isCurrentRequest()) return;
      setHosts(result.hosts); setDiagnostics(result.diagnostics);
      setSelectedId((current) => result.hosts.some((host) => host.id === current) ? current : result.hosts[0]?.id || "");
      const bastionsResult = await window.afkDesktop.jumpserver.listBastions();
      if (isCurrentRequest()) setBastions(bastionsResult);
    } catch (cause) {
      if (isCurrentRequest()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentRequest() && !background) setBusy("");
    }
  }, []);

  useEffect(() => {
    const cached = readSshHostCache();
    if (!cached || !isSshHostCacheFresh(cached)) void load();
  }, [load]);

  useEffect(() => {
    if (!selectedBastionId) return;
    void window.afkDesktop.jumpserver.getSyncLog(selectedBastionId).then((log) => {
      setSyncLogs((prev) => ({ ...prev, [selectedBastionId]: log }));
    });
  }, [selectedBastionId]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeoutId = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timeoutId);
  }, [notice]);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingHostId("");
    setCopyingHostId("");
    setAddPassword("");
    setAddBastionOpen(false);
    addHostButtonRef.current?.focus();
  }, []);

  const openAddForm = useCallback(() => {
    setEditingHostId("");
    setCopyingHostId("");
    setForm({ alias: "", hostname: "", port: 22, user: "", jumpHostType: "none" });
    setAddPassword("");
    setFormOpen(true);
    setAddBastionOpen(false);
    setBastionAddAlias(""); setBastionAddHost(""); setBastionAddPort(2222);
    setBastionAddUser(""); setBastionAddPassword(""); setBastionAddOtp("");
    setBastionAddLinuxOnly(true);
    setBastionTestState("idle"); setBastionTestError("");
    setBastionPreview([]); setBastionSelectedNames(new Set());
    setBastionSyncing(false); setBastionSyncError(""); setBastionSyncResult(undefined);
    setBastionCurrentBastionId("");
  }, []);

  const openEditForm = useCallback((host: SshHost) => {
    if (host.source !== "managed") return;
    setEditingHostId(host.id);
    setCopyingHostId("");
    setForm({ alias: host.alias, hostname: host.hostname, port: host.port, user: host.user || "", identityFile: host.identityFile, jumpHostType: host.jumpHostType || (host.proxyJump ? "openssh" : "none"), jumpHost: host.jumpHost || host.proxyJump, proxyJump: host.proxyJump, remoteWorkspace: host.remoteWorkspace });
    setAddPassword("");
    setFormOpen(true);
  }, []);

  const openCopyForm = useCallback((host: SshHost) => {
    setEditingHostId("");
    setCopyingHostId(host.id);
    setForm({ alias: nextSshHostAlias(host.alias, hosts), hostname: host.hostname, port: host.port, user: host.user || "", identityFile: host.identityFile, jumpHostType: host.jumpHostType || (host.proxyJump ? "openssh" : "none"), jumpHost: host.jumpHost || host.proxyJump, proxyJump: host.proxyJump, remoteWorkspace: host.remoteWorkspace });
    setAddPassword("");
    setFormOpen(true);
  }, [hosts]);

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
  const jumpHostCandidates = useMemo(() => hosts.filter((host) => host.alias !== form.alias.trim()).sort((left, right) => left.alias.localeCompare(right.alias)), [form.alias, hosts]);
  const groupedDiagnostics = useMemo(() => groupSshDiagnostics(diagnostics), [diagnostics]);
  const selected = filtered.find((host) => host.id === selectedId) || filtered[0] || null;

  const toggleBastionCollapse = (id: string) => setCollapsedBastions((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const bastionSyncSummary = (bastion: SshBastion) => {
    const bastionAssets = hosts.filter((h) => h.jumpHost === bastion.alias);
    const linux = bastionAssets.filter((h) => h.port === 22).length;
    const windows = bastionAssets.filter((h) => h.port !== 22).length;
    let status: "healthy" | "auth-expired" | "unreachable" | "syncing" | "stale" = "stale";
    if (bastion.lastSyncedAt) {
      const ageMs = Date.now() - new Date(bastion.lastSyncedAt).getTime();
      status = ageMs < 3 * 60 * 60 * 1000 ? "healthy" : "stale";
    }
    return { status, linux, windows, lastSyncedAt: bastion.lastSyncedAt };
  };

  const bastionAssets = (bastion: SshBastion) => hosts.filter((h) => h.jumpHost === bastion.alias);

  const displayedBastions = useMemo(() => {
    if (bastionFilter === "direct") return [];
    return bastions;
  }, [bastions, bastionFilter]);

  const directHosts = useMemo(() => {
    const bastionAliases = new Set(bastions.map((b) => b.alias));
    return filtered.filter((h) => !h.jumpHost || !bastionAliases.has(h.jumpHost));
  }, [filtered, bastions, bastionFilter]);

  const selectedBastion = bastions.find((b) => b.id === selectedBastionId) || null;
  const selectedHost = selectedBastionId ? null : selected;
  const selectedHostIsBastionManaged = selectedHost?.jumpHostType === "jumpserver" && bastions.some((b) => b.alias === selectedHost.jumpHost);
  const run = async (label: string, action: () => Promise<unknown>, successMessage: string | ((result: unknown) => string) = "操作已完成", refresh = false, backgroundRefresh = false) => {
    setBusy(label); setError(""); setNotice("");
    try {
      const result = await action();
      setNotice(typeof successMessage === "function" ? successMessage(result) : label === "test" ? "免密测试已完成" : successMessage);
      if (refresh) {
        invalidateSshHostCache();
        await load({ forceRefresh: true, background: backgroundRefresh });
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  };

  const saveHost = async () => {
    const editing = Boolean(editingHostId);
    await run(editing ? "update" : "add", async () => {
      const jumpHostType = form.jumpHostType === "none" ? undefined : form.jumpHostType;
      const { proxyJump: _proxyJump, remoteWorkspace: _remoteWorkspace, ...formWithoutProxyJump } = form;
      const input = {
        ...formWithoutProxyJump,
        user: form.user || undefined,
        remoteWorkspace: form.remoteWorkspace?.trim() || undefined,
        jumpHostType,
        jumpHost: jumpHostType ? form.jumpHost : undefined,
        ...(jumpHostType === "openssh" ? { proxyJump: form.jumpHost } : {}),
      };
      const host = editing ? await window.afkDesktop.ssh.update(editingHostId, input) : await window.afkDesktop.ssh.add(input);
      if (!editing && addPassword.trim()) {
        try {
          await window.afkDesktop.ssh.credentialSet({ hostId: host.id, password: addPassword });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`主机已保存，但部署密码保存失败：${message}`);
        }
      }
      closeForm();
      setForm({ alias: "", hostname: "", port: 22, user: "", jumpHostType: "none" });
      setSelectedId(host.id);
    }, "操作已完成", true);
  };

  const trust = () => selected?.fingerprint ? void run("trust", async () => { await window.afkDesktop.ssh.trust({ hostId: selected.id, fingerprint: selected.fingerprint! }); }, "操作已完成", true) : undefined;
  const test = () => selected ? void run("test", async () => { await window.afkDesktop.ssh.test(selected.id); }, "操作已完成", true, true) : undefined;
  const connect = () => selected ? void run(terminalId === "builtin" ? "connect" : "external", async () => {
    if (terminalId === "builtin") {
      onSession(await window.afkDesktop.ssh.connect(selected.id));
      return undefined;
    }
    return window.afkDesktop.ssh.openExternal(selected.id, terminalId);
  }, (result) => result ? `已在 ${terminalName(result as TerminalResult)} 打开 ${selected.alias}` : "内置终端已打开") : undefined;
  const generate = () => void run("generate", async () => { const result = await window.afkDesktop.ssh.generateKey(); onSession(result.session, result.publicKeyPath); });
  const deploy = () => selected ? void run("deploy", async () => { onSession(await window.afkDesktop.ssh.deployKey(selected.id)); }, "操作已完成", true) : undefined;
  const upload = () => selected ? void run("upload", async () => window.afkDesktop.ssh.upload(selected.id), (result) => result ? `已上传 ${(result as { fileName: string }).fileName}` : "已取消上传") : undefined;
  const remove = (host: SshHost) => {
    if (host.source === "managed") {
      setPendingRemoval(host);
      return;
    }
    if (host.status === "unreachable") setPendingRemoval(host);
  };
  const removalTitle = pendingRemoval?.source === "managed" ? `删除 SSH 主机 ${pendingRemoval.alias}` : pendingRemoval ? `清理不可达 SSH 主机 ${pendingRemoval.alias}` : "";
  const removalDescription = pendingRemoval?.source === "managed" ? `确定要删除 AFK 管理中的“${pendingRemoval.alias}”吗？此操作会移除 AFK 保存的主机配置。` : pendingRemoval ? `确定要从 ~/.ssh/config 清理不可达主机“${pendingRemoval.alias}”吗？系统配置文件中的对应条目将被移除。` : "";
  const confirmRemoval = () => {
    if (!pendingRemoval) return;
    const host = pendingRemoval;
    setPendingRemoval(null);
    void run("remove", async () => { await window.afkDesktop.ssh.remove(host.id); }, "操作已完成", true);
  };

  const openEditBastionForm = (bastion: SshBastion) => {
    const bastionHost = hosts.find((h) => h.alias === bastion.alias && h.jumpHostType === "jumpserver" && !h.jumpHost);
    if (bastionHost) openEditForm(bastionHost);
  };

  const removeBastion = (bastion: SshBastion) => {
    setPendingBastionRemoval(bastion);
  };

  const confirmBastionRemoval = () => {
    if (!pendingBastionRemoval) return;
    const bastion = pendingBastionRemoval;
    setPendingBastionRemoval(null);
    void run("remove-bastion", async () => {
      await window.afkDesktop.jumpserver.removeBastion(bastion.id);
      setSelectedBastionId("");
      const bastionsResult = await window.afkDesktop.jumpserver.listBastions();
      setBastions(bastionsResult);
      return "堡垒机已删除";
    }, "堡垒机已删除", true);
  };

  const openAddBastionForm = useCallback(() => {
    setEditingHostId("");
    setCopyingHostId("");
    setForm({ alias: "", hostname: "", port: 22, user: "", jumpHostType: "none" });
    setAddPassword("");
    setFormOpen(true);
    setAddBastionOpen(true);
    setBastionAddAlias(""); setBastionAddHost(""); setBastionAddPort(2222);
    setBastionAddUser(""); setBastionAddPassword(""); setBastionAddOtp("");
    setBastionAddLinuxOnly(true);
    setBastionTestState("idle"); setBastionTestError("");
    setBastionPreview([]); setBastionSelectedNames(new Set());
    setBastionSyncing(false); setBastionSyncError(""); setBastionSyncResult(undefined);
    setBastionCurrentBastionId("");
  }, []);

  const testBastion = useCallback(async () => {
    setBastionTestState("testing"); setBastionTestError("");
    try {
      const result = await window.afkDesktop.jumpserver.addBastion({
        alias: bastionAddAlias || bastionAddHost,
        hostname: bastionAddHost,
        port: bastionAddPort,
        user: bastionAddUser,
        password: bastionAddPassword,
        otpSecret: bastionAddOtp || undefined,
        linuxOnly: bastionAddLinuxOnly,
      });
      setBastionCurrentBastionId(result.bastion.id);
      setBastionPreview(result.assetPreview);
      const linuxAssets = result.assetPreview.filter((a) => a.platform.toLowerCase().startsWith("linux"));
      setBastionSelectedNames(new Set(linuxAssets.map((a) => a.name)));
      setBastionTestState("preview");
    } catch (cause) {
      setBastionTestError(cause instanceof Error ? cause.message : String(cause));
      setBastionTestState("error");
    }
  }, [bastionAddAlias, bastionAddHost, bastionAddPort, bastionAddUser, bastionAddPassword, bastionAddOtp, bastionAddLinuxOnly]);

  const toggleBastionAsset = useCallback((name: string) => {
    setBastionSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const syncBastion = useCallback(async () => {
    setBastionSyncing(true); setBastionSyncError("");
    try {
      const result = await window.afkDesktop.jumpserver.syncAssets({
        bastionId: bastionCurrentBastionId,
        selectedNames: Array.from(bastionSelectedNames),
        linuxOnly: bastionAddLinuxOnly,
      });
      setBastionSyncResult(result);
      await load({ forceRefresh: true });
    } catch (cause) {
      setBastionSyncError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBastionSyncing(false);
    }
  }, [bastionCurrentBastionId, bastionSelectedNames, bastionAddLinuxOnly, load]);

  const bastionStatusFor = (bastionId: string): "healthy" | "auth-expired" | "unreachable" | "syncing" | "stale" => {
    const summary = bastionSyncSummary(bastions.find((b) => b.id === bastionId)!);
    return summary.status;
  };
  return <section className="control-page ssh-page" aria-label="SSH 主机管理">
    <header className="control-page-heading ssh-heading"><div><p>本地基础设施</p><h1>SSH 主机</h1><span>复用系统 OpenSSH 配置，在不托管私钥和密码的前提下管理远程连接。</span></div><div className="ssh-heading-actions"><SshActionButton size="sm" variant="secondary" className="ssh-icon-action" onClick={generate} disabled={!!busy} aria-label="生成 AFK 密钥" title="生成 AFK 密钥"><KeyRound size={15} aria-hidden="true" /></SshActionButton><SshActionButton ref={addHostButtonRef} size="sm" variant="primary" className="ssh-icon-action" onClick={openAddForm} aria-label="添加 SSH 主机" title="添加 SSH 主机"><Plus size={16} aria-hidden="true" /></SshActionButton><SshActionButton size="sm" variant="secondary" onClick={openAddBastionForm} aria-label="添加堡垒机" title="添加堡垒机"><Server size={15} aria-hidden="true" /><span>添加堡垒机</span></SshActionButton></div></header>
    {error ? <div className="ssh-alert error" role="alert"><CircleAlert size={15} />{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div> : null}
    {notice ? <div className="ssh-alert success" role="status"><Check size={15} />{notice}</div> : null}
    <section className="ssh-toolbar"><label className="ssh-search"><Search size={15} /><input aria-label="搜索 SSH 主机" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索别名、地址或用户" /></label><SshFormPicker id="ssh-source-filter" ariaLabel="来源筛选" value={source} options={[{ value: "all", label: "全部来源" }, { value: "system", label: "系统配置" }, { value: "managed", label: "AFK 管理" }]} placeholder="全部来源" disabled={!!busy} onChange={(value) => setSource(value as SourceFilter)} /><SshFormPicker id="ssh-status-filter" ariaLabel="状态筛选" value={status} options={[{ value: "all", label: "全部状态" }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} placeholder="全部状态" disabled={!!busy} onChange={(value) => setStatus(value as StatusFilter)} /><SshFormPicker id="ssh-bastion-filter" ariaLabel="堡垒机筛选" value={bastionFilter} options={[{ value: "all", label: "全部" }, { value: "bastion", label: "仅堡垒机" }, { value: "direct", label: "仅直连" }]} placeholder="全部" disabled={!!busy} onChange={(value) => setBastionFilter(value as BastionFilter)} />{diagnostics.length ? <SshDiagnostics diagnostics={groupedDiagnostics} total={diagnostics.length} /> : null}<button className="icon-button" onClick={() => void load({ forceRefresh: true })} disabled={!!busy} aria-label="刷新 SSH 主机"><RefreshCw size={16} className={busy === "list" ? "spin" : ""} /></button></section>
    <section className="ssh-layout"><div className="ssh-host-list">{displayedBastions.map((bastion) => {
      const assets = bastionAssets(bastion);
      const collapsed = collapsedBastions.has(bastion.id);
      return (
        <div key={bastion.id} className="ssh-bastion-section">
          <JumpserverBastionCard
            bastion={bastion}
            collapsed={collapsed}
            selected={selectedBastionId === bastion.id}
            onToggleCollapse={() => toggleBastionCollapse(bastion.id)}
            onSelect={() => { setSelectedBastionId(bastion.id); setSelectedId(""); }}
            syncSummary={bastionSyncSummary(bastion)}
          />
          {!collapsed && assets.map((host) => (
            <SshHostRow key={host.id} host={host} selected={selected?.id === host.id && !selectedBastionId} busy={busy} onSelect={() => { setSelectedId(host.id); setSelectedBastionId(""); }} onEdit={openEditForm} onCopy={openCopyForm} onRemove={remove} />
          ))}
        </div>
      );
    })}
    {(bastionFilter === "all" || bastionFilter === "direct") && (directHosts.length ? directHosts.map((host) => <SshHostRow key={host.id} host={host} selected={selected?.id === host.id && !selectedBastionId} busy={busy} onSelect={() => { setSelectedId(host.id); setSelectedBastionId(""); }} onEdit={openEditForm} onCopy={openCopyForm} onRemove={remove} />) : displayedBastions.length === 0 && bastions.length === 0 ? <div className="ssh-empty"><Server size={24} /><b>{busy === "list" ? "正在读取 SSH 配置…" : "没有匹配的 SSH 主机"}</b><span>AFK 读取系统 `~/.ssh/config`，托管主机保存在 AFK 应用数据中。</span></div> : null)}</div>
    {selectedBastionId && selectedBastion ? (
      <JumpserverDetail
        bastion={selectedBastion}
        status={bastionStatusFor(selectedBastionId)}
        linuxCount={bastionSyncSummary(selectedBastion).linux}
        windowsCount={bastionSyncSummary(selectedBastion).windows}
        syncedHosts={bastionAssets(selectedBastion).map((h) => ({ id: h.id, alias: h.alias, user: h.user || "", hostname: h.hostname, status: h.status }))}
        syncLog={syncLogs[selectedBastionId] || []}
        busy={busy}
        onRefresh={() => run("refresh", async () => {
          const result = await window.afkDesktop.jumpserver.syncAssets({ bastionId: selectedBastionId });
          const log = await window.afkDesktop.jumpserver.getSyncLog(selectedBastionId);
          setSyncLogs((prev) => ({ ...prev, [selectedBastionId]: log }));
          await load({ forceRefresh: true });
          return result;
        })}
        onEdit={() => openEditBastionForm(selectedBastion)}
        onRemove={() => removeBastion(selectedBastion)}
      />
    ) : (
      <SshDetails
        host={selectedHost}
        busy={busy}
        terminalId={terminalId}
        onTerminalChange={setTerminalId}
        onTrust={trust}
        onTest={test}
        onConnect={connect}
        onDeploy={deploy}
        onUpload={upload}
        bastionManaged={selectedHostIsBastionManaged}
      />
    )}</section>
    {formOpen ? <AddBastionDialog
      open={formOpen}
      initialMode={addBastionOpen ? "bastion" : "ssh"}
      onClose={closeForm}
      sshForm={form}
      sshEditingId={editingHostId}
      sshAddPassword={addPassword}
      jumpHostCandidates={jumpHostCandidates}
      onSshFormChange={setForm}
      onSshPasswordChange={setAddPassword}
      onSshSubmit={saveHost}
      bastionAlias={bastionAddAlias}
      bastionHost={bastionAddHost}
      bastionPort={bastionAddPort}
      bastionUser={bastionAddUser}
      bastionPassword={bastionAddPassword}
      bastionOtp={bastionAddOtp}
      bastionLinuxOnly={bastionAddLinuxOnly}
      onBastionFieldChange={(field, value) => {
        if (field === "alias") setBastionAddAlias(value as string);
        else if (field === "host") setBastionAddHost(value as string);
        else if (field === "port") setBastionAddPort(value as number);
        else if (field === "user") setBastionAddUser(value as string);
        else if (field === "password") setBastionAddPassword(value as string);
        else if (field === "otp") setBastionAddOtp(value as string);
        else if (field === "linuxOnly") setBastionAddLinuxOnly(value as boolean);
      }}
      bastionTestState={bastionTestState}
      bastionTestError={bastionTestError}
      bastionPreview={bastionPreview}
      bastionSelectedNames={bastionSelectedNames}
      bastionSyncing={bastionSyncing}
      bastionSyncError={bastionSyncError}
      bastionSyncResult={bastionSyncResult}
      onBastionTest={testBastion}
      onBastionToggleAsset={toggleBastionAsset}
      onBastionSync={syncBastion}
      onBastionClearError={() => { setBastionTestState("idle"); setBastionTestError(""); }}
      busy={!!busy}
    /> : null}
    {pendingRemoval ? <SshConfirmDialog title={removalTitle} description={removalDescription} confirmLabel={pendingRemoval.source === "managed" ? "确认删除" : "确认清理"} confirmAriaLabel={pendingRemoval.source === "managed" ? `确认删除 SSH 主机 ${pendingRemoval.alias}` : `确认清理不可达 SSH 主机 ${pendingRemoval.alias}`} onConfirm={confirmRemoval} onCancel={() => setPendingRemoval(null)} /> : null}
    {pendingBastionRemoval ? <SshConfirmDialog title={`删除堡垒机 ${pendingBastionRemoval.alias}`} description={`确定要删除堡垒机“${pendingBastionRemoval.alias}”吗？这将同时删除该堡垒机同步的所有资产。`} confirmLabel="确认删除" confirmAriaLabel={`确认删除堡垒机 ${pendingBastionRemoval.alias}`} onConfirm={confirmBastionRemoval} onCancel={() => setPendingBastionRemoval(null)} /> : null}
  </section>;
}

function SshDetails({ host, busy, terminalId, onTerminalChange, onTrust, onTest, onConnect, onDeploy, onUpload, bastionManaged }: { host: SshHost | null; busy: string; terminalId: SshTerminalId; onTerminalChange: (value: SshTerminalId) => void; onTrust: () => void; onTest: () => void; onConnect: () => void; onDeploy: () => void; onUpload: () => void; bastionManaged?: boolean }) {
  if (!host) return <aside className="ssh-details empty"><Server size={22} /><span>选择主机查看连接详情</span></aside>;
  const blocked = host.status === "identity-changed" || host.status === "invalid";
  return <aside className="ssh-details" aria-label={`${host.alias} SSH 详情`}>
    <header><div className="ssh-details-heading-copy"><small>{sourceLabels[host.source]}</small><h2>{host.alias}</h2><span>{host.user ? `${host.user}@` : ""}{host.hostname}:{host.port}</span></div><span className={`ssh-status ${host.status}`}>{statusLabels[host.status]}</span></header>
    {bastionManaged ? <div className="ssh-bastion-managed-notice">由堡垒机管理，仅支持基础操作</div> : null}
    <dl><div><dt>配置来源</dt><dd>{host.configPath}</dd></div><div><dt>HostName</dt><dd>{host.hostname}</dd></div><div><dt>IdentityFile</dt><dd>{host.identityFile || "未指定（跟随系统 SSH 配置）"}</dd></div><div><dt>上传目录</dt><dd>{host.remoteWorkspace || "远程主目录"}</dd></div><div><dt>ProxyJump</dt><dd>{host.proxyJump || "无"}</dd></div>{host.fingerprint ? <div><dt>主机指纹</dt><dd className="fingerprint">{host.fingerprint.algorithm} · {host.fingerprint.value}</dd></div> : null}</dl>
    <div className="ssh-actions">
      <div className="ssh-detail-action-groups">
        {host.status === "untrusted" && host.fingerprint ? <SshActionButton size="sm" variant="primary" className="ssh-trust-action" onClick={onTrust} disabled={!!busy}><ShieldCheck size={15} />信任此指纹</SshActionButton> : null}
        {host.status === "auth-required" && !blocked && !bastionManaged ? <SshActionButton size="sm" variant="secondary" className="ssh-deploy-action" onClick={onDeploy} disabled={!!busy}><Copy size={15} />部署公钥</SshActionButton> : null}
        <div className="ssh-auxiliary-actions"><SshActionButton size="sm" variant="secondary" className="ssh-test-action" onClick={onTest} disabled={!!busy || blocked || host.status === "untrusted"}>{busy === "test" ? <RefreshCw size={15} className="spin" /> : <Link2 size={15} />}{busy === "test" ? "测试中…" : "测试免密"}</SshActionButton>{!bastionManaged && <SshActionButton size="sm" variant="secondary" className="ssh-upload-action" onClick={onUpload} disabled={!!busy || blocked || host.status !== "ready"}>{busy === "upload" ? <RefreshCw size={15} className="spin" /> : <Upload size={15} />}{busy === "upload" ? "上传中…" : "快速上传"}</SshActionButton>}</div>
        <div className="ssh-connection-actions"><div className="ssh-terminal-picker"><SshTerminalPicker value={terminalId} onChange={onTerminalChange} disabled={!!busy || blocked || host.status !== "ready"} /><SshActionButton size="sm" variant="primary" className="ssh-connect-action" onClick={onConnect} disabled={!!busy || blocked || host.status !== "ready"}>{busy === "connect" || busy === "external" ? "连接中…" : "连接"}</SshActionButton></div></div>
      </div>
    </div>
    {busy === "connect" ? <p className="ssh-action-status" role="status" aria-live="polite">正在打开内置终端…</p> : null}{busy === "external" ? <p className="ssh-action-status" role="status" aria-live="polite">正在启动 {terminalLabels[terminalId]}…</p> : null}{busy === "upload" ? <p className="ssh-action-status" role="status" aria-live="polite">正在选择并上传文件到 {host.remoteWorkspace || "远程主目录"}…</p> : null}
  </aside>;
}
