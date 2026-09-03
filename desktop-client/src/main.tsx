import { useEffect, useMemo, useRef, useState } from "react";
/** AFK Control design: quiet local-operations shell; runtime cards are secondary to Timeline evidence and stay concise. */
import { createRoot } from "react-dom/client";
import {
  Activity, Archive, Bot, Boxes, Braces, Check, ChevronDown, ChevronRight, CircleCheck, CircleDashed,
  Clock3, Command, Container, FolderOpen, LayoutList, Minus, Move, Plus, RefreshCw, ChevronLeft,
  Send, Settings2, Sparkles, Terminal, TerminalSquare, TriangleAlert, Workflow, X,
} from "lucide-react";
import "./styles.css";
import "./timeline.css";
import "./runtime.css";
import "./replay.css";
import "./layout.css";
import "./palette.css";
import "./control.css";
import claudeIcon from "./assets/runtime-icons/claude-official.ico";
import codexIcon from "./assets/runtime-icons/codex-openai-official.png";
import geminiIcon from "./assets/runtime-icons/gemini-cli-official.png";
import openCodeIcon from "./assets/runtime-icons/opencode-official.svg";
import { presentationSnapshot } from "./mock-data";
import { normalizeWorkflowSteps, workflowStepLayout } from "./features/workflows/graph/normalize";
import { CANVAS_NODE_HEIGHT, CANVAS_NODE_WIDTH, CANVAS_WORLD_HEIGHT, CANVAS_WORLD_WIDTH, clampCanvasPosition, hasCanvasNodeCollisions, layoutCanvasNodes } from "./features/workflows/graph/canvas-layout";
import { Empty } from "./components/EmptyState";
import { Settings } from "./features/settings/SettingsPage";
import { SshHostsPage } from "./features/ssh/SshHostsPage";
import { TerminalSheet } from "./features/terminal/TerminalSheet";
import { applySshSessionEvents, createEarlySshSessionBuffer, type SshTerminalState } from "./features/terminal/ssh-session-buffer";
import type { SshSession } from "../shared/ssh-contract";

type Phase = "ready" | "active" | "verify" | "attention";
type RecordStatus = "queued" | "running" | "waiting_confirmation" | "completed" | "failed";
type View = "queue" | "board" | "workflows" | "agents" | "containers" | "events" | "ssh" | "settings";

const label: Record<Phase, string> = {
  ready: "待执行",
  active: "执行中",
  verify: "已完成",
  attention: "待处理",
};

const recordStatusLabel: Record<RecordStatus, string> = {
  queued: "待执行",
  running: "运行中",
  waiting_confirmation: "待确认",
  completed: "已完成",
  failed: "失败",
};

const defaultAppearance: AppearancePreferences = { locale: "system", fontFamily: "system", fontScale: "medium", accent: "violet", theme: "light" };

function eventStatus(event: RuntimeEvent): RecordStatus {
  const structured = String(event.status ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (["waiting_confirmation", "awaiting_confirmation", "attention_required", "hitl_requested", "blocked", "needs_confirmation"].includes(structured)) return "waiting_confirmation";
  if (["running", "active", "agent_exec", "tool_start", "in_progress"].includes(structured)) return "running";
  if (["completed", "complete", "success", "verify_pass", "passed", "done", "tool_result"].includes(structured)) return "completed";
  if (["failed", "error", "cancelled", "aborted", "timed_out"].includes(structured)) return "failed";
  if (["queued", "pending", "created"].includes(structured)) return "queued";

  const text = (event.status + " " + event.result + " " + event.nextStep + " " + event.raw).toLowerCase();
  if (/等待确认|待确认|需要确认|配置异常|attention_required|hitl|handoff/.test(text)) return "waiting_confirmation";
  if (/失败|错误|异常|无法|error|fail|blocked|timeout/.test(text)) return "failed";
  if (/已完成|完成|已通过|通过|success|pass|completed/.test(text)) return "completed";
  if (/正在|执行中|运行中|agent|exec|validate|分析中/.test(text)) return "running";
  return "queued";
}

function phaseOf(event: RuntimeEvent): Phase {
  const status = eventStatus(event);
  if (status === "running") return "active";
  if (status === "completed") return "verify";
  if (status === "waiting_confirmation" || status === "failed") return "attention";
  return "ready";
}

function Track({ phase, index, variant = "full", live = false, fresh = false }: { phase: Phase; index: number; variant?: "compact" | "card" | "full" | "archive"; live?: boolean; fresh?: boolean }) {
  const position = phase === "active" ? 61 : phase === "verify" ? 83 : phase === "attention" ? 45 : 18;
  return (
    <div className={`track track-${phase} track-${variant}${live ? " is-live" : ""}${fresh ? " is-fresh" : ""}`} aria-label={`${label[phase]} Timeline${live ? "，当前正在运行" : ""}`} role="img">
      <span className="track-stage prepare">准备</span><span className="track-stage execute">执行</span><span className="track-stage verify">验证</span>
      <i className="track-rail" />
      <i className="track-segment first" />
      <i className="track-segment second" />
      <i className="track-segment third" />
      <i className="track-check first" />
      <i className="track-check second" />
      <i className="track-check third" />
      <i className="track-playhead" style={{ left: `${Math.min(92, position + (index % 4) * 2)}%` }} />
      <i className="track-focus-ring" style={{ left: `${Math.min(92, position + (index % 4) * 2)}%` }} />
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("queue");
  const [runMode, setRunMode] = useState<"queue" | "board">("queue");
  const [workspace, setWorkspace] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [selected, setSelected] = useState<RuntimeEvent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState("");
  const [terminal, setTerminal] = useState<SshTerminalState>({ open: false, pane: "", mode: "tmux" });
  const [line, setLine] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [replayRun, setReplayRun] = useState("");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [appearance, setAppearance] = useState<AppearancePreferences>(defaultAppearance);
  const freshTimer = useRef<number | null>(null);
  const refreshInFlight = useRef(false);
  const activeSshSessionId = useRef<string | null>(null);
  const earlySshSessionBuffer = useRef(createEarlySshSessionBuffer());

  const refresh = async (target = workspace) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const liveSnapshot = await window.afkDesktop.snapshot(target);
      const { snapshot: next, demo } = presentationSnapshot(liveSnapshot);
      setIsDemo(demo);
      const priorIds = new Set(snapshot?.events.map((item) => item.id) ?? []);
      const addedIds = snapshot ? next.events.filter((item) => !priorIds.has(item.id)).map((item) => item.id) : [];
      setSnapshot(next);
      if (addedIds.length) {
        setFreshIds(new Set(addedIds));
        if (freshTimer.current) window.clearTimeout(freshTimer.current);
        freshTimer.current = window.setTimeout(() => setFreshIds(new Set()), 1400);
      }
      setWorkspace(next.workspace.root);
      setSelected((current) => current ? next.events.find((item) => item.id === current.id) ?? null : null);
      setReplayRun((current) => next.events.some((item) => item.source === current) ? current : next.events[0]?.source ?? "");
      if (!session && next.sessions[0]) setSession(next.sessions[0].name);
      setLastCheckedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  };

  useEffect(() => () => { if (freshTimer.current) window.clearTimeout(freshTimer.current); }, []);
  useEffect(() => { void refresh(""); }, []);
  useEffect(() => { void window.afkDesktop.appearance().then(setAppearance).catch(() => setAppearance(defaultAppearance)); }, []);
  useEffect(() => {
    const buffer = earlySshSessionBuffer.current;
    const offData = window.afkDesktop.ssh.onData((sessionId, data) => {
      if (activeSshSessionId.current === sessionId) setTerminal((current) => applySshSessionEvents(current, sessionId, [{ type: "data", data }]));
      else buffer.pushData(sessionId, data);
    });
    const offExit = window.afkDesktop.ssh.onExit((sessionId, code) => {
      if (activeSshSessionId.current === sessionId) {
        setTerminal((current) => applySshSessionEvents(current, sessionId, [{ type: "exit", code }]));
        activeSshSessionId.current = null;
        buffer.close(sessionId);
      } else buffer.pushExit(sessionId, code);
    });
    return () => { offData(); offExit(); buffer.clearAll(); };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.afkTheme = appearance.theme;
    root.dataset.afkAccent = appearance.accent;
    root.dataset.afkFont = appearance.fontFamily;
    root.dataset.afkScale = appearance.fontScale;
  }, [appearance]);

  const groups = useMemo(() => {
    const value: Record<Phase, RuntimeEvent[]> = { ready: [], active: [], verify: [], attention: [] };
    (snapshot?.events ?? []).forEach((event) => value[phaseOf(event)].push(event));
    return value;
  }, [snapshot]);

  const selectWorkspace = async () => {
    const directory = await window.afkDesktop.chooseWorkspace();
    if (directory) await refresh(directory);
  };

  const openSession = async (name: string) => {
    activeSshSessionId.current = null;
    setSession(name);
    setConfirmed(false);
    setTerminal({ open: true, pane: "正在读取 tmux 窗格…", mode: "tmux" });
    try {
      const pane = await window.afkDesktop.tmuxPane(workspace, name);
      setTerminal({ open: true, pane, mode: "tmux" });
    } catch (cause) {
      setTerminal({ open: true, pane: `无法读取会话：${String(cause)}`, mode: "tmux" });
    }
  };

  const openSshSession = (sshSession: SshSession, publicKeyPath?: string) => {
    activeSshSessionId.current = sshSession.id;
    const bufferedEvents = earlySshSessionBuffer.current.open(sshSession.id);
    setTerminal(applySshSessionEvents({ open: true, pane: "", mode: "ssh", sshSession, publicKeyPath }, sshSession.id, bufferedEvents));
    if (bufferedEvents.some((event) => event.type === "exit")) {
      activeSshSessionId.current = null;
      earlySshSessionBuffer.current.close(sshSession.id);
    }
  };
  const closeTerminal = () => {
    if (terminal.mode === "ssh" && terminal.sshSession) {
      activeSshSessionId.current = null;
      earlySshSessionBuffer.current.close(terminal.sshSession.id);
      if (terminal.sshSession.state !== "closed") void window.afkDesktop.ssh.close(terminal.sshSession.id);
    }
    setTerminal((current) => ({ ...current, open: false }));
  };

  const sendInput = async () => {
    if (!confirmed || !session || !line.trim()) return;
    try {
      await window.afkDesktop.tmuxSend(workspace, session, line);
      setTerminal({ open: true, pane: await window.afkDesktop.tmuxPane(workspace, session), mode: "tmux" });
      setLine("");
      setConfirmed(false);
    } catch (cause) {
      setTerminal((current) => ({ ...current, pane: `${current.pane}\n\n[发送失败] ${String(cause)}` }));
    }
  };

  const nav: Array<[View, string, typeof LayoutList]> = [
    ["queue", "运行", Workflow],
    ["workflows", "工作流", Boxes],
    ["events", "记录", Archive],
    ["agents", "Agent", Activity],
    ["containers", "环境", Container],
    ["ssh", "SSH 主机", Terminal],
  ];
  const activeNav = view === "board" ? "queue" : view;
  const title = view === "settings" ? "设置" : nav.find(([key]) => key === activeNav)?.[1] ?? "运行";
  const events = snapshot?.events ?? [];
  const runtimes = snapshot?.agentRuntimes ?? [];
  const availableRuntimeCount = runtimes.filter((runtime) => runtime.available).length;
  const runtimeTotal = runtimes.length || 4;
  const unavailableRuntimeCount = runtimes.filter((runtime) => !runtime.available).length;
  const activateView = (nextView: View) => {
    setView(nextView);
    if (nextView === "events" && selected) setReplayRun(selected.source);
    setSelected(null);
  };
  const openEventDetails = (event: RuntimeEvent) => {
    setSelected(event);
    setInspectorCollapsed(false);
  };
  const updateAppearance = (patch: Partial<AppearancePreferences>) => {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    void window.afkDesktop.saveAppearance(next).then(setAppearance).catch(() => undefined);
  };
  const saveWorkflowConfig = async (workflow: WorkflowConfigSummary) => {
    const saved = await window.afkDesktop.saveWorkflow(workspace, workflow);
    const { snapshot: refreshed, demo } = presentationSnapshot(await window.afkDesktop.snapshot(workspace));
    const customTemplate = workflow.templateName === "afk-control-workflow" && workflow.canvasNodes.length ? { id: "afk-control-workflow", name: "自定义工作流", description: "由 AFK Control 管理的项目级可执行模板。", source: "managed" as const, steps: workflow.canvasNodes.map((node, index) => ({ id: node.id, role: node.template === "qa" ? "reviewer" : "implementer", kind: "agent" as const, provider: node.provider, dependsOn: index ? [workflow.canvasNodes[index - 1].id] : [] })) } : undefined;
    setIsDemo(demo);
    setSnapshot(customTemplate ? { ...refreshed, workflow: saved, workflowTemplates: [...refreshed.workflowTemplates.filter(template => template.id !== customTemplate.id), customTemplate] } : refreshed);
    setWorkspace(refreshed.workspace.root);
    return saved;
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">A</span><strong>AFK <b>/</b> CONTROL</strong><small>LOCAL OPERATIONS</small></div>
        <button className="quick-run" onClick={() => { setRunMode("queue"); setView("queue"); }}><Workflow size={18} />新建运行</button>
        <nav className="primary-nav">{nav.map(([key, text, Icon]) => <button key={key} className={activeNav === key ? "nav-item active" : "nav-item"} onClick={() => { if (key === "queue") setRunMode("queue"); activateView(key); }}><Icon size={16} />{text}{key === "agents" && runtimes.length ? <em className="healthy-badge">{availableRuntimeCount}/{runtimeTotal}</em> : null}</button>)}</nav>
        <section className="sidebar-projects" aria-label="项目">
          <div className="sidebar-section-title"><span>项目</span><button onClick={() => void selectWorkspace()} aria-label="选择工作区">+</button></div>
          <button className="project-row" onClick={() => void selectWorkspace()}><FolderOpen size={17} /><span><b>{snapshot?.workspace.root.split("/").pop() ?? "选择工作区"}</b><small>{snapshot?.workspace.afkDirectoryPresent ? ".afk 已发现" : "选择 AFK 工作区"}</small></span></button>
          <button className="project-activity" onClick={() => { setRunMode("board"); setView("board"); }}><i className={events.length ? "activity-pulse" : ""} /><span>{isDemo ? "演示数据" : events.length ? "本地运行正常" : "等待本地运行状态"}</span></button>
        </section>
        <div className="sidebar-bottom">
          <button className={view === "settings" ? "local-action settings-entry active" : "local-action settings-entry"} onClick={() => activateView("settings")}><Settings2 size={15} />设置</button>
        </div>
      </aside>

      <section className="content-shell">
        <header className="topbar">
          <div className="topbar-context"><div className="breadcrumb"><span>AFK</span><b>›</b><strong>{title}</strong></div>{view === "queue" || view === "board" ? <div className="run-view-switcher header-run-mode" aria-label="运行视图切换"><button className={runMode === "queue" ? "active" : ""} onClick={() => { setRunMode("queue"); setView("queue"); }}><LayoutList size={14} />队列</button><button className={runMode === "board" ? "active" : ""} onClick={() => { setRunMode("board"); setView("board"); }}><Workflow size={14} />看板</button></div> : null}{view === "agents" ? <AgentHeaderSummary available={availableRuntimeCount} total={runtimeTotal} unavailable={unavailableRuntimeCount} /> : null}</div>
          <div className="top-actions"><button className="command" onClick={() => setCommandOpen((current) => !current)}><Command size={15} />命令 <kbd>⌘ K</kbd></button><button className="icon-button" onClick={() => void refresh()}><RefreshCw size={16} className={loading ? "spin" : ""} /></button></div>
        </header>
        {commandOpen ? <div className="command-sheet"><header><span>命令</span><button onClick={() => setCommandOpen(false)}><X size={14} /></button></header><button onClick={() => { void refresh(); setCommandOpen(false); }}><RefreshCw size={14} />重新读取</button><button onClick={() => { setView("board"); setCommandOpen(false); }}><Workflow size={14} />打开看板</button><button onClick={() => { void selectWorkspace(); setCommandOpen(false); }}><FolderOpen size={14} />选择工作区</button></div> : null}
        {error ? <div className="error-banner"><X size={15} />{error}</div> : null}
        <div className="workspace">
          {view === "queue" ? <Queue events={events} selected={selected} freshIds={freshIds} onSelect={openEventDetails} /> : null}
          {view === "board" ? <Board groups={groups} selected={selected} freshIds={freshIds} onSelect={openEventDetails} /> : null}
          {view === "agents" ? <Agents snapshot={snapshot} loading={loading} lastCheckedAt={lastCheckedAt} onRefresh={() => void refresh()} /> : null}
          {view === "containers" ? <Environments snapshot={snapshot} onTerminal={openSession} /> : null}
          {view === "ssh" ? <SshHostsPage onSession={openSshSession} /> : null}
          {view === "workflows" ? <Workflows snapshot={snapshot} onSave={saveWorkflowConfig} /> : null}
          {view === "events" ? <Replay events={events} selected={selected} freshIds={freshIds} activeRun={replayRun} onRunChange={setReplayRun} onSelect={openEventDetails} onClose={() => setSelected(null)} /> : null}
          {view === "settings" ? <Settings appearance={appearance} onChange={updateAppearance} /> : null}
        </div>
        {selected && view !== "containers" && view !== "events" && view !== "workflows" && view !== "settings" ? <Inspector event={selected} fresh={freshIds.has(selected.id)} collapsed={inspectorCollapsed} onToggle={() => setInspectorCollapsed((current) => !current)} onTerminal={() => session && void openSession(session)} /> : null}
      </section>
      {terminal.open ? <TerminalSheet mode={terminal.mode} session={session} pane={terminal.pane} line={line} confirmed={confirmed} sshSession={terminal.sshSession} onClose={closeTerminal} onLine={setLine} onConfirmed={setConfirmed} onSend={() => void sendInput()} onSshInput={(data) => {
        const sshSession = terminal.sshSession;
        if (!sshSession || sshSession.state === "closed" || sshSession.state === "failed") return;
        return window.afkDesktop.ssh.input({ sessionId: sshSession.id, data });
      }} onSshResize={(cols, rows) => {
        const sshSession = terminal.sshSession;
        if (!sshSession || sshSession.state === "closed" || sshSession.state === "failed") return;
        return window.afkDesktop.ssh.resize({ sessionId: sshSession.id, cols, rows });
      }} /> : null}
    </main>
  );
}

function Queue({ events, selected, freshIds, onSelect }: { events: RuntimeEvent[]; selected: RuntimeEvent | null; freshIds: Set<string>; onSelect: (event: RuntimeEvent) => void }) {
  const phases: Phase[] = ["ready", "active", "verify", "attention"];
  if (!events.length) return <Empty />;
  return <section className="queue">{phases.map((phase) => {
    const rows = events.filter((event) => phaseOf(event) === phase);
    if (!rows.length) return null;
    return <div className={`phase-group phase-${phase}`} key={phase}><header><span className={`status-dot ${phase}`} /><b>{label[phase]}</b><small>{rows.length.toString().padStart(2, "0")} 条记录</small></header>{rows.map((event) => <EventRow key={event.id} event={event} fresh={freshIds.has(event.id)} selected={selected?.id === event.id} onSelect={onSelect} />)}</div>;
  })}</section>;
}

function EventRow({ event, fresh, selected, onSelect }: { event: RuntimeEvent; fresh: boolean; selected: boolean; onSelect: (event: RuntimeEvent) => void }) {
  const phase = phaseOf(event);
  return <button className={`event-row ${selected ? "selected" : ""} ${phase}${fresh ? " fresh" : ""}`} onClick={() => onSelect(event)} aria-label={`查看 ${event.source} 的详情`}><span className="event-icon"><Clock3 size={15} /></span><span className="event-copy"><span><b>{event.source}</b><strong>{event.result}</strong></span><small><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time> · {event.nextStep}</small></span><span className="event-detail-affordance">详情 <ChevronRight size={14} /></span></button>;
}

function Board({ groups, selected, freshIds, onSelect }: { groups: Record<Phase, RuntimeEvent[]>; selected: RuntimeEvent | null; freshIds: Set<string>; onSelect: (event: RuntimeEvent) => void }) {
  const phases: Phase[] = ["ready", "active", "verify", "attention"];
  return <section className="board">{phases.map((phase) => <article className={`board-column ${phase}`} key={phase}><header><span className={`status-dot ${phase}`} /><b>{label[phase]}</b><em>{groups[phase].length}</em></header>{groups[phase].map((event) => <button className={`${selected?.id === event.id ? "board-card selected" : "board-card"}${freshIds.has(event.id) ? " fresh" : ""}`} key={event.id} onClick={() => onSelect(event)}><div><small><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time></small><b>{event.source}</b></div><strong>{event.result}</strong><p>→ {event.nextStep}</p><span className="board-detail-affordance">详情 <ChevronRight size={13} /></span></button>)}{!groups[phase].length ? <p className="drop-note">暂无记录</p> : null}</article>)}</section>;
}

function RuntimeProductIcon({ id }: { id: AgentRuntime["id"] }) {
  const icons: Partial<Record<AgentRuntime["id"], string>> = { claude: claudeIcon, codex: codexIcon, opencode: openCodeIcon };
  const icon = icons[id];
  return <span className={`runtime-product-icon ${id}`} aria-hidden="true">{icon ? <img src={icon} alt="" /> : <Bot size={15} />}</span>;
}

function RuntimeStatusIcon({ status, label }: { status: AgentRuntime["status"]; label: string }) {
  const icons = { available: CircleCheck, missing: CircleDashed, error: TriangleAlert };
  const Icon = icons[status];
  return <span className={`runtime-status-icon ${status}`} title={label} aria-label={`状态：${label}`}><Icon size={13} strokeWidth={2} /></span>;
}

function AgentHeaderSummary({ available, total, unavailable }: { available: number; total: number; unavailable: number }) {
  return <div className="agent-header-summary" aria-label="Agent 工具检测摘要"><span className="agent-summary-available"><CircleCheck size={13} />{available}/{total} 可执行</span>{unavailable ? <span className="agent-summary-error"><TriangleAlert size={13} />{unavailable} 未通过</span> : null}</div>;
}

function Agents({ snapshot, loading, onRefresh }: { snapshot: Snapshot | null; loading: boolean; lastCheckedAt: number | null; onRefresh: () => void }) {
  const runtimes = snapshot?.agentRuntimes ?? [];
  const statusLabel: Record<AgentRuntime["status"], string> = { available: "可执行", missing: "未发现", error: "检测失败" };
  return <section className="table-panel agent-panel"><header><span>本机 Agent 工具</span><button className={`runtime-refresh${loading ? " checking" : ""}`} disabled={loading} onClick={onRefresh}><Settings2 size={15} className={loading ? "spin" : ""} />{loading ? "检查中…" : "重新检查"}</button></header><div className="agent-list">{runtimes.length ? runtimes.map((runtime) => <article className={`agent-runtime ${runtime.status}`} key={runtime.id}><RuntimeProductIcon id={runtime.id} /><RuntimeStatusIcon status={runtime.status} label={statusLabel[runtime.status]} /><div className="runtime-identity"><b>{runtime.label}</b><small title={runtime.executable || runtime.command}>{runtime.executable || runtime.command}</small></div><span className="runtime-summary" title={runtime.summary}>{runtime.summary}</span><strong title={`发现来源：${runtime.installation.source}`}>{statusLabel[runtime.status]}</strong></article>) : <p className="agent-empty"><b>{loading ? "正在检测本机工具…" : "尚未检测 Agent 工具"}</b><br />检查 AFK CLI provider：Claude Code、Codex、Cursor Agent、Pi、OpenCode 与 GitHub Copilot。</p>}</div></section>;
}

function Environments({ snapshot, onTerminal }: { snapshot: Snapshot | null; onTerminal: (name: string) => void }) {
  const containers = snapshot?.containers ?? [];
  const sessions = snapshot?.sessions ?? [];
  return <section className="environment-grid" aria-label="AFK 已登记执行环境">
    <article><header><Container size={18} /><b>AFK 容器</b><span>{containers.length}</span></header>{containers.length ? containers.map((item) => <div className="env-row" key={`${item.engine}-${item.name}`}><span>{item.engine}</span><b>{item.name}</b><small>{item.image}</small><em>{item.status}</em></div>) : <p>当前工作区没有由 AFK 登记且仍在运行的容器。</p>}</article>
    <article><header><TerminalSquare size={18} /><b>AFK tmux 会话</b><span>{sessions.length}</span></header>{sessions.length ? sessions.map((item) => <div className="env-row" key={item.name}><span>{item.attached ? "attached" : "detached"}</span><b>{item.name}</b><small>{item.windows} 个窗口</small><button onClick={() => onTerminal(item.name)}>打开终端</button></div>) : <p>当前工作区没有由 AFK 登记且仍可用的 tmux 会话。</p>}</article>
  </section>;
}

function durationLabel(milliseconds: number) {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60 ? `${minutes % 60} 分` : ""}`.trim();
  return `${minutes} 分`;
}

function workflowStatusLabel(status: WorkflowRunSummary["status"]) {
  const labels: Record<WorkflowRunSummary["status"], string> = { running: "运行中", completed: "已完成", blocked: "已阻塞", failed: "失败", aborted: "已中止", timed_out: "已超时", context_high: "上下文阈值" };
  return labels[status];
}

type WorkflowCanvasNodeId = "loop" | "source" | "prepare" | "execute" | "guardrails" | "verify";
type WorkflowCanvasNode = { id: string; number: string; title: string; caption: string; state: "active" | "ready" | "muted" | "complete"; x: number; y: number; template?: CanvasTemplateNode["template"]; custom?: CanvasTemplateNode; step?: WorkflowTemplateStepSummary };
type WorkflowNodePosition = { x: number; y: number };
type WorkflowCanvasTrack = "agent" | "system" | "conditional";
type WorkflowCanvasEdge = { from: WorkflowCanvasNode; to: WorkflowCanvasNode; when?: WorkflowTemplateStepSummary["when"] };
const DEFAULT_WORKFLOW_NODE_POSITIONS: Record<WorkflowCanvasNodeId, WorkflowNodePosition> = {
  loop: { x: 90, y: 190 }, source: { x: 315, y: 95 }, prepare: { x: 550, y: 260 }, execute: { x: 795, y: 100 }, guardrails: { x: 1030, y: 270 }, verify: { x: 1275, y: 120 },
};

function validateWorkflowDraft(workflow: WorkflowConfigSummary): string | null {
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(workflow.tmuxSession)) return "tmux 会话只能包含字母、数字、点、下划线、连字符或冒号。";
  for (const [label, value] of [["目标分支", workflow.targetBranch], ["基准分支", workflow.baseBranch]] as const) if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.endsWith("/")) return label + "不是有效 Git 分支名。";
  const limits: Array<[string, number, number, number]> = [["工作流超时", workflow.hardTimeoutMs, 1_000, 86_400_000], ["完成等待", workflow.completionTimeoutMs, 1_000, 86_400_000], ["最大重试", workflow.maxRetries, 0, 20], ["上下文阈值", workflow.contextThreshold, 1_000, 10_000_000], ["总令牌预算", workflow.goalBudget, 1_000, 100_000_000]];
  for (const [label, value, min, max] of limits) if (!Number.isInteger(value) || value < min || value > max) return label + "必须在 " + min.toLocaleString() + " 到 " + max.toLocaleString() + " 之间。";
  if (workflow.codex.endpoint && workflow.codex.endpoint !== "stdio://" && !/^(https?|wss?):\/\//.test(workflow.codex.endpoint)) return "Codex App Server 地址必须使用 http(s)、ws(s) 或 stdio://。";
  if (workflow.codex.authTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(workflow.codex.authTokenEnv)) return "Token 环境变量名称必须以字母或下划线开头，且只能包含字母、数字和下划线。";
  if (!Number.isInteger(workflow.codex.startupTimeoutMs) || workflow.codex.startupTimeoutMs < 1_000 || workflow.codex.startupTimeoutMs > 300_000) return "Codex 启动超时必须在 1,000 到 300,000 ms 之间。";
  return null;
}

function workflowSourceLabel(source: WorkflowTemplateSummary["source"]) {
  return source === "builtin" ? "AFK 内置" : source === "managed" ? "本项目 · 自定义" : "本项目";
}


function workflowTrack(step?: WorkflowTemplateStepSummary): WorkflowCanvasTrack { return step?.when ? "conditional" : step?.kind === "system" ? "system" : "agent"; }
function workflowTrackLabel(track: WorkflowCanvasTrack) { return track === "agent" ? "Agent 步骤" : track === "system" ? "系统操作" : "条件分支"; }

function Workflows({ snapshot, onSave }: { snapshot: Snapshot | null; onSave: (workflow: WorkflowConfigSummary) => Promise<WorkflowConfigSummary> }) {
  const [mode, setMode] = useState<"library" | "editor">("library");
  const [selected, setSelected] = useState<string>("start");
  const [draft, setDraft] = useState<WorkflowConfigSummary | null>(null);
  const [savedCustomTemplate, setSavedCustomTemplate] = useState<WorkflowTemplateSummary | null>(null);
  if (!snapshot) return <Empty />;
  const { workflow, workflowRuns, loop, workflowTemplates } = snapshot;
  const templates = savedCustomTemplate ? [...workflowTemplates.filter(template => template.id !== savedCustomTemplate.id), savedCustomTemplate] : workflowTemplates;
  const model = draft ?? workflow;
  const activeTemplate = templates.find(template => template.id === model.templateName) ?? (model.templateName === "afk-control-workflow" ? { id: "afk-control-workflow", name: "自定义工作流", description: "由 AFK Control 管理的项目级可执行模板。", source: "managed" as const, steps: [] } : undefined);
  const openTemplate = (template: WorkflowTemplateSummary) => {
    const isCurrentManagedTemplate = workflow.templateName === template.id && template.source === "managed";
    setDraft({ ...workflow, templateName: template.id, canvasNodes: isCurrentManagedTemplate ? workflow.canvasNodes : [] });
    setSelected("start");
    setMode("editor");
  };
  const createCustom = () => {
    setDraft({ ...workflow, templateName: "afk-control-workflow", canvasNodes: [] });
    setSelected("start");
    setMode("editor");
  };
  const rememberCustomTemplate = (candidate: WorkflowConfigSummary) => {
    if (candidate.templateName !== "afk-control-workflow" || !candidate.canvasNodes.length) return;
    setSavedCustomTemplate({ id: "afk-control-workflow", name: "自定义工作流", description: "由 AFK Control 管理的项目级可执行模板。", source: "managed", steps: candidate.canvasNodes.map((node, index) => ({ id: node.id, role: node.template === "qa" ? "reviewer" : "implementer", kind: "agent", provider: node.provider, dependsOn: index ? [candidate.canvasNodes[index - 1].id] : [] })) });
  };
  if (mode === "library") return <WorkflowLibrary templates={templates} activeTemplateName={model.templateName || workflow.templateName} workflowRuns={workflowRuns} onOpen={openTemplate} onCreate={createCustom} />;
  return <WorkflowStudio workflow={workflow} model={model} activeTemplate={activeTemplate} loop={loop} workflowRuns={workflowRuns} onSave={onSave} onSavedTemplate={rememberCustomTemplate} onBack={() => { rememberCustomTemplate(model); setDraft(null); setMode("library"); }} selected={selected} onSelected={setSelected} onDraft={setDraft} />;
}

function WorkflowLibrary({ templates, activeTemplateName, onOpen, onCreate }: { templates: WorkflowTemplateSummary[]; activeTemplateName?: string; workflowRuns: WorkflowRunSummary[]; onOpen: (template: WorkflowTemplateSummary) => void; onCreate: () => void }) {
  return <section className="workflow-library" aria-label="工作流列表">
    <header className="workflow-library-heading"><div><p>WORKFLOWS</p><h1>工作流</h1><span>选择一个模板，在画布中查看或配置其执行链路。</span></div><button className="workflow-create" onClick={onCreate}><Plus size={14} />新建</button></header>
    <div className="workflow-library-grid">{templates.map(template => { const active = template.id === activeTemplateName; const agentSteps = template.steps.filter(step => step.kind === "agent").length; return <button key={template.id} className={"workflow-library-card" + (active ? " active" : "")} onClick={() => onOpen(template)}><span className="workflow-library-source">{workflowSourceLabel(template.source)}</span><div className="workflow-library-copy"><b>{template.name}</b><p>{template.description}</p></div><div className="workflow-library-meta"><span>{template.steps.length} 步 · {agentSteps} Agent</span>{active ? <em>当前</em> : <ChevronRight size={15} />}</div></button>; })}</div>
    {!templates.length ? <div className="workflow-library-empty"><b>尚未发现工作流模板</b><span>新建后会在项目 .afk/workflows 目录创建可执行模板。</span><button className="workflow-create" onClick={onCreate}><Plus size={14} />新建</button></div> : null}
  </section>;
}

function WorkflowStudio({ workflow, model, activeTemplate, loop, workflowRuns, onSave, onSavedTemplate, onBack, selected, onSelected, onDraft }: { workflow: WorkflowConfigSummary; model: WorkflowConfigSummary; activeTemplate?: WorkflowTemplateSummary; loop: LoopStatus; workflowRuns: WorkflowRunSummary[]; onSave: (workflow: WorkflowConfigSummary) => Promise<WorkflowConfigSummary>; onSavedTemplate: (workflow: WorkflowConfigSummary) => void; onBack: () => void; selected: string; onSelected: (id: string) => void; onDraft: (draft: WorkflowConfigSummary | null | ((current: WorkflowConfigSummary | null) => WorkflowConfigSummary)) => void }) {
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [traceToken, setTraceToken] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panStart = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const nodeDrag = useRef<{ id: string; x: number; y: number; left: number; top: number; custom?: boolean } | null>(null);
  const dirty = JSON.stringify(model) !== JSON.stringify(workflow);
  const laidOutCanvasNodes = model.canvasNodes.length && hasCanvasNodeCollisions(model.canvasNodes) ? layoutCanvasNodes(model.canvasNodes) : model.canvasNodes;
  useEffect(() => {
    if (!model.canvasNodes.length || !hasCanvasNodeCollisions(model.canvasNodes)) return;
    onDraft(current => ({ ...(current ?? workflow), canvasNodes: layoutCanvasNodes((current ?? workflow).canvasNodes) }));
  }, [model.canvasNodes, onDraft, workflow]);
  const selectNode = (id: string) => { onSelected(id); setInspectorOpen(true); setTraceToken(token => token + 1); };
  const patch = (next: Partial<WorkflowConfigSummary>) => { onDraft(current => ({ ...(current ?? workflow), ...next })); setSaveError(null); };
  const patchCodex = (next: Partial<WorkflowConfigSummary["codex"]>) => { onDraft(current => { const baseline = current ?? workflow; return { ...baseline, codex: { ...baseline.codex, ...next } }; }); setSaveError(null); };
  const updateTemplate = (id: string, patchValue: Partial<CanvasTemplateNode>) => { onDraft(current => { const baseline = current ?? workflow; return { ...baseline, canvasNodes: baseline.canvasNodes.map(node => node.id === id ? { ...node, ...patchValue } : node) }; }); setSaveError(null); };
  const removeTemplate = (id: string) => { onDraft(current => { const baseline = current ?? workflow; return { ...baseline, canvasNodes: baseline.canvasNodes.filter(node => node.id !== id) }; }); setSaveError(null); if (selected === id) selectNode("start"); };
  const addTemplate = (template: CanvasTemplateNode["template"]) => {
    const id = template + "-" + Date.now();
    onDraft(current => { const baseline = current ?? workflow; const index = baseline.canvasNodes.filter(node => node.template === template).length + 1; const defaults = template === "qa" ? { description: "验证验收条件、测试结果与合并前质量。", prompt: "Verify the implemented backlog change against its acceptance criteria. Report concise PASS or FAIL evidence before completion." } : { description: "实现当前工作项，并留下简洁的执行与验证摘要。", prompt: "Implement the assigned backlog item in the current AFK worktree. Follow the repository conventions, run relevant checks, and leave a concise completion summary." }; const next: CanvasTemplateNode = { id, template, label: template === "agent" ? "Agent " + index : "QA " + index, provider: baseline.agentDefault as CanvasTemplateNode["provider"], x: 0, y: 0, ...defaults }; const firstQa = baseline.canvasNodes.findIndex(node => node.template === "qa"); const canvasNodes = template === "agent" && firstQa >= 0 ? [...baseline.canvasNodes.slice(0, firstQa), next, ...baseline.canvasNodes.slice(firstQa)] : [...baseline.canvasNodes, next]; return { ...baseline, canvasNodes: layoutCanvasNodes(canvasNodes), templateName: "afk-control-workflow" }; });
    setSaveError(null); selectNode(id);
  };
  const builtinSteps = activeTemplate?.steps ?? [];
  const graphDiagnostics = normalizeWorkflowSteps(builtinSteps).diagnostics;
  const builtinLayout = workflowStepLayout(builtinSteps);
  const rootPositions = builtinSteps.filter(step => !step.dependsOn.length).map(step => builtinLayout.get(step.id)).filter((position): position is WorkflowNodePosition => Boolean(position));
  const rootY = rootPositions.length ? Math.round(rootPositions.reduce((total, position) => total + position.y, 0) / rootPositions.length) : Math.round((CANVAS_WORLD_HEIGHT - CANVAS_NODE_HEIGHT) / 2);
  const startNode: WorkflowCanvasNode = { id: "start", number: "00", title: "开始", caption: activeTemplate?.name || "选择模板", state: dirty ? "active" : "ready", x: 48, y: rootY };
  const customNodes: WorkflowCanvasNode[] = laidOutCanvasNodes.map((node, index) => ({ id: node.id, number: node.template === "agent" ? "A" + (index + 1) : "Q" + (index + 1), title: node.label, caption: node.description, state: "ready", x: node.x, y: node.y, template: node.template, custom: node }));
  const customLanes = model.canvasNodes.length ? [...new Map(laidOutCanvasNodes.map(node => [node.y, { y: node.y - 30, height: CANVAS_NODE_HEIGHT + 60, label: "阶段 " + String(Math.round((node.y - 74) / 154) + 1).padStart(2, "0") }])).values()] : [];
  const builtinNodes: WorkflowCanvasNode[] = builtinSteps.map((step, index) => { const position = builtinLayout.get(step.id) ?? { x: 220, y: 202 }; const role = step.kind === "system" ? (step.action || "system") : step.role; const condition = step.when ? " · 仅当 " + step.when.step + "=" + step.when.equals : ""; return { id: "step-" + step.id, number: String(index + 1).padStart(2, "0"), title: step.id, caption: role + condition, state: "ready", ...position, step }; });
  const builtinTracks = (["agent", "system", "conditional"] as WorkflowCanvasTrack[]).map(track => {
    const trackNodes = builtinNodes.filter(node => workflowTrack(node.step) === track);
    if (!trackNodes.length) return null;
    const minY = Math.min(...trackNodes.map(node => node.y));
    const maxY = Math.max(...trackNodes.map(node => node.y + CANVAS_NODE_HEIGHT));
    return { id: track, label: workflowTrackLabel(track), y: minY - 28, height: maxY - minY + 56 };
  }).filter((track): track is { id: WorkflowCanvasTrack; label: string; y: number; height: number } => Boolean(track));
  const builtinPhases = [...new Map(builtinNodes.map(node => [node.x, { x: node.x, label: "阶段 " + node.number }])).values()];
  const templateNodes = customNodes.length ? customNodes : builtinNodes;
  const nodes = [startNode, ...templateNodes];
  const selectedNode = nodes.find(node => node.id === selected) ?? startNode;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !nodes.length) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = stage.getBoundingClientRect();
      const minX = Math.min(...nodes.map(node => node.x));
      const maxX = Math.max(...nodes.map(node => node.x + CANVAS_NODE_WIDTH));
      const minY = Math.min(...nodes.map(node => node.y));
      const maxY = Math.max(...nodes.map(node => node.y + CANVAS_NODE_HEIGHT));
      const graphWidth = Math.max(1, maxX - minX);
      const graphHeight = Math.max(1, maxY - minY);
      const padX = Math.min(96, Math.max(36, rect.width * .1));
      const padY = Math.min(92, Math.max(32, rect.height * .12));
      const inspectorReserve = inspectorOpen && rect.width >= 980 ? 332 : 0;
      const visibleWidth = Math.max(1, rect.width - inspectorReserve);
      const scale = Math.max(.72, Math.min(1.12, (visibleWidth - padX * 2) / graphWidth, (rect.height - padY * 2) / graphHeight));
      const targetCenterY = Math.max(padY + graphHeight * scale / 2, Math.min(rect.height * .34, rect.height - padY - graphHeight * scale / 2));
      setViewport({ scale: Math.round(scale * 100) / 100, x: Math.round((visibleWidth - graphWidth * scale) / 2 - minX * scale), y: Math.round(targetCenterY - (minY + graphHeight / 2) * scale) });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTemplate?.id, inspectorOpen, model.templateName, model.canvasNodes.length]);
  const byId = (id: string) => nodes.find(node => node.id === id);
  const edgeElbowX = (from: WorkflowCanvasNode, to: WorkflowCanvasNode) => {
    const startX = from.x + CANVAS_NODE_WIDTH; const endX = to.x; const gap = endX - startX;
    const clearance = Math.max(1, Math.min(34, Math.abs(gap) * .5));
    return Math.round(endX - (gap >= 0 ? clearance : -clearance));
  };
  const edgePath = (from: WorkflowCanvasNode, to: WorkflowCanvasNode) => {
    const startX = from.x + CANVAS_NODE_WIDTH; const startY = from.y + CANVAS_NODE_HEIGHT / 2; const endX = to.x; const endY = to.y + CANVAS_NODE_HEIGHT / 2;
    if (Math.abs(startY - endY) < 6) return "M" + startX + " " + startY + " H " + endX;
    const elbowX = edgeElbowX(from, to);
    return "M" + startX + " " + startY + " H " + elbowX + " V " + endY + " H " + endX;
  };
  const edgeLabelPosition = (from: WorkflowCanvasNode, to: WorkflowCanvasNode) => ({ x: edgeElbowX(from, to) + 8, y: Math.round((from.y + CANVAS_NODE_HEIGHT / 2 + to.y + CANVAS_NODE_HEIGHT / 2) / 2 - 9) });
  const templateEdges: WorkflowCanvasEdge[] = customNodes.length ? customNodes.map((node, index) => ({ from: index === 0 ? startNode : customNodes[index - 1], to: node })) : builtinNodes.flatMap(node => { const dependencies = node.step?.dependsOn ?? []; if (!dependencies.length) return [{ from: startNode, to: node }]; return dependencies.map((id): WorkflowCanvasEdge | null => { const from = byId("step-" + id); return from ? { from, to: node, when: node.step?.when } : null; }).filter((edge): edge is WorkflowCanvasEdge => edge !== null); });
  const relatedNodeIds = new Set(templateEdges.flatMap(({ from, to }) => from.id === selected || to.id === selected ? [from.id, to.id] : []));
  const save = async () => { const localError = validateWorkflowDraft(model); if (localError) { setSaveError(localError); return; } setSaving(true); setSaveError(null); try { const saved = await onSave(model); onDraft(saved); onSavedTemplate(model); } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); } };
  const zoomOut = () => setViewport(current => ({ ...current, scale: Math.max(.7, Math.round((current.scale - .1) * 100) / 100) }));
  const zoomIn = () => setViewport(current => ({ ...current, scale: Math.min(1.35, Math.round((current.scale + .1) * 100) / 100) }));
  const resetViewport = () => setViewport({ x: 0, y: 0, scale: 1 });
  const autoLayout = () => {
    if (model.canvasNodes.length) onDraft(current => { const baseline = current ?? workflow; return { ...baseline, canvasNodes: layoutCanvasNodes(baseline.canvasNodes) }; });
    setViewport({ x: 0, y: 0, scale: 1 });
    setTraceToken(token => token + 1);
    setSaveError(null);
  };
  return <section className="workflow-studio-page" aria-label="工作流画布编辑器">
    {graphDiagnostics.length ? <div className="workflow-graph-warning" role="alert">工作流模板存在 {graphDiagnostics.length} 个结构问题，已隐藏无效连线。</div> : null}
    <header className="workflow-studio-topbar"><button className="workflow-back" onClick={onBack}><ChevronLeft size={16} />工作流</button><div className="workflow-studio-title"><span>{activeTemplate ? workflowSourceLabel(activeTemplate.source) : "AFK 工作流"}</span><b>{activeTemplate?.name || "未选择模板"}</b><small>{activeTemplate?.description || "选择一个模板或新建自定义工作流。"}</small></div><div className="workflow-studio-actions">{dirty ? <span className="workflow-dirty">未保存</span> : null}<button className="workflow-save" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></div></header>
    <div className="workflow-studio-shell">
      <section className="workflow-studio-canvas" aria-label="工作流画布">
        <header><div><b>执行画布</b><small>{model.canvasNodes.length ? "自定义节点会写入当前项目的 AFK 模板；拖动可调整画布布局。" : "当前展示所选模板的真实步骤。添加自定义节点会创建项目级可执行模板。"}</small></div><div className="workflow-studio-toolbar"><button className="workflow-toolbar-button" onClick={() => addTemplate("agent")}><Plus size={13} />Agent</button><button className="workflow-toolbar-button" onClick={() => addTemplate("qa")}><Plus size={13} />QA</button></div></header>
        <div ref={stageRef} className={"workflow-editor-stage" + (draggingNode ? " is-dragging" : "")} onPointerDown={event => { const target = event.target as Element; if (!target.closest(".workflow-editor-node") && !target.closest(".workflow-canvas-controls") && !target.closest(".workflow-studio-inspector") && !target.closest(".workflow-inspector-trigger")) { panStart.current = { x: event.clientX, y: event.clientY, offsetX: viewport.x, offsetY: viewport.y }; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={event => { const dragging = nodeDrag.current; if (dragging) { const x = clampCanvasPosition(dragging.left + (event.clientX - dragging.x) / viewport.scale, 22, CANVAS_WORLD_WIDTH - CANVAS_NODE_WIDTH - 22); const y = clampCanvasPosition(dragging.top + (event.clientY - dragging.y) / viewport.scale, 22, CANVAS_WORLD_HEIGHT - CANVAS_NODE_HEIGHT - 22); updateTemplate(dragging.id, { x, y }); const rect = stageRef.current?.getBoundingClientRect(); if (rect) { const edge = 54; const panX = event.clientX < rect.left + edge ? Math.ceil((rect.left + edge - event.clientX) / 9) : event.clientX > rect.right - edge ? -Math.ceil((event.clientX - (rect.right - edge)) / 9) : 0; const panY = event.clientY < rect.top + edge ? Math.ceil((rect.top + edge - event.clientY) / 9) : event.clientY > rect.bottom - edge ? -Math.ceil((event.clientY - (rect.bottom - edge)) / 9) : 0; if (panX || panY) setViewport(current => ({ ...current, x: current.x + panX, y: current.y + panY })); } return; } const start = panStart.current; if (!start) return; setViewport(current => ({ ...current, x: start.offsetX + event.clientX - start.x, y: start.offsetY + event.clientY - start.y })); }} onPointerUp={() => { panStart.current = null; nodeDrag.current = null; setDraggingNode(null); }} onPointerCancel={() => { panStart.current = null; nodeDrag.current = null; setDraggingNode(null); }}>
          <div className="workflow-editor-world" style={{ transform: "translate(" + viewport.x + "px, " + viewport.y + "px) scale(" + viewport.scale + ")" }}>{customLanes.length ? <div className="workflow-canvas-lanes" aria-hidden="true">{customLanes.map(lane => <div key={lane.y} className="workflow-canvas-lane" style={{ top: lane.y, height: lane.height }}><span>{lane.label}</span><small>EXECUTION PATH</small></div>)}</div> : null}{!customNodes.length && builtinNodes.length ? <><div className="workflow-canvas-phases" aria-hidden="true">{builtinPhases.map(phase => <span key={phase.x} style={{ left: phase.x }}>{phase.label}</span>)}</div><div className="workflow-canvas-tracks" aria-hidden="true">{builtinTracks.map(track => <div key={track.id} className={"workflow-canvas-track track-" + track.id} style={{ top: track.y, height: track.height }}><span>{track.label}</span></div>)}</div></> : null}<svg className="workflow-editor-edges" viewBox={"0 0 " + CANVAS_WORLD_WIDTH + " " + CANVAS_WORLD_HEIGHT} aria-hidden="true"><defs><marker id="workflow-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L0,7 L6,3.5 z" /></marker></defs>{templateEdges.map(({ from, to, when }) => { const path = edgePath(from, to); const linked = selected === from.id || selected === to.id; const condition = when ? when.step + " = " + when.equals : null; const label = condition ? edgeLabelPosition(from, to) : null; const labelWidth = condition ? Math.max(72, condition.length * 5 + 14) : 0; return <g className={"workflow-edge" + (linked ? " linked" : "") + (condition ? " conditional" : "")} key={from.id + "-" + to.id + "-" + traceToken}><path className="workflow-edge-base" d={path} /><path className="workflow-edge-flow" d={path} />{condition && label ? <g className="workflow-edge-label" transform={"translate(" + label.x + " " + label.y + ")"}><rect x="-7" y="-8" width={labelWidth} height="16" rx="3" /><text x="0" y="3">{condition}</text></g> : null}</g>; })}</svg>{nodes.map(node => <button key={node.id} className={"workflow-editor-node " + node.state + (selected === node.id ? " selected" : "") + (relatedNodeIds.has(node.id) ? " related" : "") + (node.id === "start" ? " origin-node" : "") + (node.template ? " template-" + node.template : "") + (node.custom ? " custom-node" : "") + (node.step ? " track-" + workflowTrack(node.step) : "") + (node.step?.kind === "agent" ? " agent-node" : "") + (node.step?.kind === "system" ? " system-node" : "") + (draggingNode === node.id ? " dragging" : "")} style={{ left: node.x, top: node.y }} onPointerDown={event => { event.stopPropagation(); selectNode(node.id); nodeDrag.current = node.custom ? { id: node.id, x: event.clientX, y: event.clientY, left: node.x, top: node.y, custom: true } : null; setDraggingNode(node.custom ? node.id : null); event.currentTarget.setPointerCapture(event.pointerId); }} onClick={() => selectNode(node.id)} aria-pressed={selected === node.id}><i>{node.number}</i><span className="workflow-editor-node-copy"><b>{node.title}</b><small>{node.caption}</small></span><em aria-label={node.custom ? "自定义步骤" : node.step?.kind === "system" ? "系统步骤" : node.step ? "执行步骤" : "工作流起点"} /></button>)}</div>
          <div className="workflow-canvas-controls"><button className="workflow-canvas-control" onClick={autoLayout} aria-label="自动整理画布" title="自动整理"><RefreshCw size={13} /></button><button className="workflow-canvas-control" onClick={zoomOut} aria-label="缩小画布"><Minus size={14} /></button><span>{Math.round(viewport.scale * 100)}%</span><button className="workflow-canvas-control" onClick={zoomIn} aria-label="放大画布"><Plus size={14} /></button><button className="workflow-canvas-control" onClick={resetViewport} aria-label="重置画布"><Move size={14} /></button></div>{inspectorOpen ? <WorkflowStudioInspector node={selectedNode} workflow={model} loop={loop} runs={workflowRuns} onPatch={patch} onCodexPatch={patchCodex} onTemplatePatch={updateTemplate} onDeleteTemplate={removeTemplate} dirty={dirty} saving={saving} error={saveError} onSave={save} onReset={() => { onDraft(workflow); setSaveError(null); }} onCollapse={() => setInspectorOpen(false)} /> : <button className="workflow-inspector-trigger" onClick={() => setInspectorOpen(true)} aria-label={selectedNode.title + " 配置"}><Settings2 size={15} /><span>配置</span></button>}
        </div>
        <footer><span>{model.templateName ? "模板：" + model.templateName : "未选择模板"}</span><span>{model.canvasNodes.length ? "自定义节点 " + model.canvasNodes.length : "模板步骤 " + (activeTemplate?.steps.length || 0)}</span></footer>
      </section>
    </div>
  </section>;
}

function WorkflowStudioInspector({ node, workflow, loop, runs, onPatch, onCodexPatch, onTemplatePatch, onDeleteTemplate, dirty, saving, error, onSave, onReset, onCollapse }: { node: WorkflowCanvasNode; workflow: WorkflowConfigSummary; loop: LoopStatus; runs: WorkflowRunSummary[]; onPatch: (patch: Partial<WorkflowConfigSummary>) => void; onCodexPatch: (patch: Partial<WorkflowConfigSummary["codex"]>) => void; onTemplatePatch: (id: string, patch: Partial<CanvasTemplateNode>) => void; onDeleteTemplate: (id: string) => void; dirty: boolean; saving: boolean; error: string | null; onSave: () => Promise<void>; onReset: () => void; onCollapse: () => void }) {
  const field = (label: string, value: string | number, onChange: (next: string) => void, options?: string[]) => <label className="workflow-field" key={label}><span>{label}</span>{options ? <select value={String(value)} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option} value={option}>{option || "继承默认 Agent"}</option>)}</select> : <input value={String(value)} onChange={event => onChange(event.target.value)} />}</label>;
  const numberField = (label: string, value: number, onChange: (next: number) => void) => <label className="workflow-field" key={label}><span>{label}</span><input type="number" min="0" value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
  const textareaField = (label: string, value: string, onChange: (next: string) => void) => <label className="workflow-field workflow-textarea" key={label}><span>{label}</span><textarea value={value} onChange={event => onChange(event.target.value)} /></label>;
  const readOnly = (label: string, value: string) => <div className="workflow-readonly" key={label}><span>{label}</span><b title={value}>{value}</b></div>;
  const template = node.custom;
  let content: Array<ReturnType<typeof field>>;
  if (template) content = [field("节点名称", template.label, value => onTemplatePatch(template.id, { label: value })), field("执行 Agent", template.provider || "", value => onTemplatePatch(template.id, { provider: (value || undefined) as CanvasTemplateNode["provider"] }), ["", "claude-code", "codex", "cursor", "pi", "opencode", "copilot"]), textareaField("节点说明", template.description, value => onTemplatePatch(template.id, { description: value })), textareaField("执行指令", template.prompt, value => onTemplatePatch(template.id, { prompt: value })), numberField("横向位置", template.x, value => onTemplatePatch(template.id, { x: value })), numberField("纵向位置", template.y, value => onTemplatePatch(template.id, { y: value }))];
  else if (node.step) content = [readOnly("步骤 ID", node.step.id), readOnly("角色", node.step.role), readOnly("类型", node.step.kind === "agent" ? "Agent" : "系统操作"), readOnly("执行者", node.step.provider || (node.step.kind === "agent" ? workflow.agentDefault : "AFK CLI")), ...(node.step.action ? [readOnly("系统动作", node.step.action)] : []), ...(node.step.when ? [readOnly("执行条件", node.step.when.step + " = " + node.step.when.equals)] : []), readOnly("依赖", node.step.dependsOn.length ? node.step.dependsOn.join(" · ") : "从开始节点")];
  else if (node.id === "start") content = [field("默认 Agent", workflow.agentDefault, value => onPatch({ agentDefault: value }), ["claude-code", "codex", "cursor", "pi", "opencode", "copilot"]), field("tmux 会话", workflow.tmuxSession, value => onPatch({ tmuxSession: value })), field("目标分支", workflow.targetBranch, value => onPatch({ targetBranch: value })), field("基准分支", workflow.baseBranch, value => onPatch({ baseBranch: value })), numberField("最大重试", workflow.maxRetries, value => onPatch({ maxRetries: value })), numberField("工作流超时（ms）", workflow.hardTimeoutMs, value => onPatch({ hardTimeoutMs: value }))];
  else if (node.id === "execute") content = [field("默认 Agent", workflow.agentDefault, value => onPatch({ agentDefault: value }), ["claude-code", "codex", "cursor", "pi", "opencode", "copilot"]), field("Codex 传输", workflow.codex.transport, value => onCodexPatch({ transport: value }), ["auto", "exec", "app-server"]), field("Codex 鉴权", workflow.codex.auth, value => onCodexPatch({ auth: value }), ["auto", "chatgpt", "api"]), field("模型提供方", workflow.codex.provider, value => onCodexPatch({ provider: value })), field("Profile", workflow.codex.profile || "", value => onCodexPatch({ profile: value || undefined })), field("App Server", workflow.codex.endpoint || "", value => onCodexPatch({ endpoint: value || undefined })), field("Token 环境变量", workflow.codex.authTokenEnv || "", value => onCodexPatch({ authTokenEnv: value || undefined })), numberField("Codex 启动超时（ms）", workflow.codex.startupTimeoutMs, value => onCodexPatch({ startupTimeoutMs: value }))];
  else if (node.id === "guardrails") content = [numberField("工作流超时（ms）", workflow.hardTimeoutMs, value => onPatch({ hardTimeoutMs: value })), numberField("完成等待（ms）", workflow.completionTimeoutMs, value => onPatch({ completionTimeoutMs: value })), numberField("最大重试", workflow.maxRetries, value => onPatch({ maxRetries: value })), numberField("上下文阈值", workflow.contextThreshold, value => onPatch({ contextThreshold: value })), numberField("总令牌预算", workflow.goalBudget, value => onPatch({ goalBudget: value }))];
  else if (node.id === "loop") content = [readOnly("状态", loop.state === "running" ? "运行中" : "未运行"), readOnly("进程", loop.pid ? String(loop.pid) : "—"), readOnly("实现链路", loop.implement.active ? loop.implement.ids.join(" · ") : "无活动任务"), readOnly("QA 队列", loop.qa.queue.length ? loop.qa.queue.join(" · ") : "空")];
  else if (node.id === "prepare") content = [readOnly("Sandbox", "local（AFK CLI 默认）"), readOnly("执行模式", "interactive（AFK CLI 默认）"), readOnly("目标分支", workflow.targetBranch), readOnly("基准分支", workflow.baseBranch)];
  else content = [readOnly("完成总数", String(loop.totals.completed)), readOnly("失败总数", String(loop.totals.failed)), readOnly("QA 活动", loop.qa.active === null ? "无" : String(loop.qa.active)), readOnly("最近结果", runs[0] ? workflowStatusLabel(runs[0].status) : "暂无")];
  const editable = Boolean(template) || node.id === "start";
  return <aside className="workflow-studio-inspector" aria-label={node.title + " 配置"}><header><span>{node.number}</span><div><small>{template ? "自定义可执行节点" : editable ? "工作流配置" : node.step ? "模板步骤" : "运行时状态"}</small><b>{node.title}</b></div><button className="workflow-inspector-collapse" onClick={onCollapse} aria-label="收起配置"><ChevronRight size={15} /></button></header><p>{node.caption}</p><div className="workflow-inspector-fields">{content}</div>{error ? <p className="workflow-save-error" role="alert">{error}</p> : null}{editable ? <footer>{template ? <button className="workflow-reset destructive" disabled={saving} onClick={() => onDeleteTemplate(template.id)}>移除节点</button> : <button className="workflow-reset" disabled={!dirty || saving} onClick={onReset}>还原</button>}<button className="workflow-save" disabled={!dirty || saving} onClick={() => void onSave()}>{saving ? "保存中…" : "保存"}</button><small>{template ? "节点信息会写入项目级 AFK 模板，并在下次工作流执行时生效。" : "保存会原子写入 .afk/config.yml；无关配置项会保留。"}</small></footer> : <footer><small>{node.step ? "这是 AFK 模板的只读步骤摘要。新增自定义 Agent 或 QA 节点会创建项目级可编辑模板。" : "该节点代表 AFK CLI 的运行时状态。请选择可编辑节点以修改配置。"}</small></footer>}</aside>;
}

function ConfigItem({ label, value }: { label: string; value: string }) {
  return <div className="config-item"><small>{label}</small><b title={value}>{value}</b></div>;
}

function replayTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function displayTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfEventDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysApart = Math.round((startOfToday - startOfEventDay) / 86_400_000);
  const day = daysApart === 0 ? "今天" : daysApart === 1 ? "昨天" : daysApart === -1 ? "明天" : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return `${day} ${replayTime(value)}`;
}

function replayChronology(events: RuntimeEvent[]) {
  return events.map((event, position) => ({ event, position })).sort((left, right) => {
    const leftTime = Date.parse(left.event.timestamp);
    const rightTime = Date.parse(right.event.timestamp);
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return left.position - right.position;
    return leftTime - rightTime;
  }).map(({ event }) => event);
}

type ReplayRun = { source: string; events: RuntimeEvent[]; latest: RuntimeEvent };

function replayRuns(events: RuntimeEvent[]): ReplayRun[] {
  const grouped = new Map<string, RuntimeEvent[]>();
  events.forEach((event) => grouped.set(event.source, [...(grouped.get(event.source) ?? []), event]));
  return [...grouped.entries()].map(([source, runEvents]) => {
    const chronologicalEvents = replayChronology(runEvents);
    return { source, events: chronologicalEvents, latest: chronologicalEvents.at(-1)! };
  }).sort((left, right) => Date.parse(right.latest.timestamp) - Date.parse(left.latest.timestamp));
}

function Replay({ events, selected, freshIds, activeRun, onRunChange, onSelect, onClose }: { events: RuntimeEvent[]; selected: RuntimeEvent | null; freshIds: Set<string>; activeRun: string; onRunChange: (source: string) => void; onSelect: (event: RuntimeEvent) => void; onClose: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && pickerRef.current && !pickerRef.current.contains(event.target)) setPickerOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismissOnEscape); };
  }, [pickerOpen]);
  if (!events.length) return <Empty />;
  const runs = replayRuns(events);
  const currentRun = runs.find((run) => run.source === activeRun) ?? runs[0];
  if (!currentRun) return <Empty />;
  const currentStatus = eventStatus(currentRun.latest);
  const detailEvent = selected && currentRun.events.some((event) => event.id === selected.id) ? selected : null;
  const chooseRun = (source: string) => {
    onRunChange(source);
    onClose();
    setPickerOpen(false);
  };

  return <section className="record-page" aria-label="运行记录">
    <header className="record-page-header">
      {runs.length > 1 ? <div className="record-run-picker" ref={pickerRef}><button className="record-run-trigger" aria-haspopup="listbox" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}><span><b>{currentRun.source}</b><small>{currentRun.events.length} 条记录 · {displayTimestamp(currentRun.latest.timestamp)}</small></span><ChevronDown size={15} /></button>{pickerOpen ? <div className="record-run-options" role="listbox" aria-label="选择运行">{runs.map((run) => <button key={run.source} role="option" aria-selected={run.source === currentRun.source} onClick={() => chooseRun(run.source)}><span><b>{run.source}</b><small>{run.events.length} 条记录 · {displayTimestamp(run.latest.timestamp)}</small></span><RecordStatus status={eventStatus(run.latest)} /></button>)}</div> : null}</div> : <div className="record-run-identity"><b>{currentRun.source}</b><small>{displayTimestamp(currentRun.latest.timestamp)}</small></div>}
      {currentRun.events.length > 1 ? <RecordStatus status={currentStatus} /> : null}
    </header>
    {currentRun.events.length === 1 ? <RecordCard event={currentRun.latest} fresh={freshIds.has(currentRun.latest.id)} onDetails={() => onSelect(currentRun.latest)} /> : <RecordList events={currentRun.events} selected={detailEvent} freshIds={freshIds} onSelect={onSelect} />}
    {detailEvent ? <RecordDrawer event={detailEvent} onClose={onClose} /> : null}
  </section>;
}

function RecordStatus({ status }: { status: RecordStatus }) {
  return <span className={"record-status " + status}>{recordStatusLabel[status]}</span>;
}

function RecordCard({ event, fresh, onDetails }: { event: RuntimeEvent; fresh: boolean; onDetails: () => void }) {
  const status = eventStatus(event);
  return <article className={"record-card " + status + (fresh ? " fresh" : "")}><div className="record-card-main"><RecordStatus status={status} /><h1>{event.result}</h1><p>{event.nextStep}</p></div><footer><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time><button onClick={onDetails}>查看详情 <ChevronRight size={15} /></button></footer></article>;
}

function RecordList({ events, selected, freshIds, onSelect }: { events: RuntimeEvent[]; selected: RuntimeEvent | null; freshIds: Set<string>; onSelect: (event: RuntimeEvent) => void }) {
  return <div className="record-list">{events.map((event) => {
    const status = eventStatus(event);
    return <button className={"record-list-item " + status + (selected?.id === event.id ? " selected" : "") + (freshIds.has(event.id) ? " fresh" : "")} key={event.id} onClick={() => onSelect(event)}><time dateTime={event.timestamp} title={event.timestamp}>{replayTime(event.timestamp)}</time><RecordStatus status={status} /><span><b>{event.result}</b><small>{event.nextStep}</small></span><ChevronRight size={15} /></button>;
  })}</div>;
}

function RecordDrawer({ event, onClose }: { event: RuntimeEvent; onClose: () => void }) {
  const status = eventStatus(event);
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const dismiss = (pointerEvent: PointerEvent) => {
      if (pointerEvent.target instanceof Node && drawerRef.current && !drawerRef.current.contains(pointerEvent.target)) onClose();
    };
    const dismissOnEscape = (keyEvent: KeyboardEvent) => { if (keyEvent.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismissOnEscape); };
  }, [onClose]);
  return <aside className="record-drawer" ref={drawerRef} role="complementary" aria-label="记录详情"><header><span>记录详情</span><button className="icon-button" onClick={onClose} aria-label="关闭详情"><X size={16} /></button></header><div className="record-drawer-body"><RecordStatus status={status} /><h2>{event.result}</h2><p className="record-drawer-next">{event.nextStep}</p><dl><div><dt>运行</dt><dd>{event.source}</dd></div><div><dt>时间</dt><dd><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time></dd></div></dl><details className="record-debug"><summary><Braces size={15} />调试信息</summary><pre>{event.raw}</pre></details></div></aside>;
}

function Inspector({ event, fresh, collapsed, onToggle, onTerminal }: { event: RuntimeEvent; fresh: boolean; collapsed: boolean; onToggle: () => void; onTerminal: () => void }) {
  const phase = phaseOf(event);
  const [panelMounted, setPanelMounted] = useState(!collapsed);
  const [restoreMounted, setRestoreMounted] = useState(collapsed);
  const [motion, setMotion] = useState<"open" | "opening" | "closing" | "collapsed">(collapsed ? "collapsed" : "open");
  const motionTimer = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { if (motionTimer.current) window.clearTimeout(motionTimer.current); }, []);
  useEffect(() => {
    if (collapsed) return;
    const dismiss = (pointerEvent: PointerEvent) => {
      if (!(pointerEvent.target instanceof Node)) return;
      const inPanel = Boolean(panelRef.current?.contains(pointerEvent.target));
      const inRestore = Boolean(restoreRef.current?.contains(pointerEvent.target));
      const inTerminal = Boolean(document.querySelector(".terminal-sheet")?.contains(pointerEvent.target));
      if (!inPanel && !inRestore && !inTerminal) onToggle();
    };
    const dismissOnEscape = (keyEvent: KeyboardEvent) => { if (keyEvent.key === "Escape") onToggle(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismissOnEscape); };
  }, [collapsed, onToggle]);
  useEffect(() => {
    if (motionTimer.current) window.clearTimeout(motionTimer.current);
    if (collapsed) {
      setMotion("closing");
      motionTimer.current = window.setTimeout(() => { setPanelMounted(false); setRestoreMounted(true); setMotion("collapsed"); }, 340);
      return;
    }
    setPanelMounted(true);
    setRestoreMounted(true);
    setMotion("opening");
    motionTimer.current = window.setTimeout(() => { setMotion("open"); setRestoreMounted(false); }, 340);
  }, [collapsed]);
  const cornerIcon = <svg className="inspector-corner-mark" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 3.5H5.6A1.1 1.1 0 0 0 4.5 4.6v6.9" /></svg>;
  return <>{panelMounted ? <aside className={`inspector inspector-${motion}${fresh ? " fresh" : ""}`} ref={panelRef}><header><button className="inspector-toggle" onClick={onToggle} aria-label="收起详情">{cornerIcon}<span className="inspector-tooltip" role="tooltip">收起详情</span></button><span><i className={`status-dot ${phase}`} />详情</span></header><div className="inspector-surface"><div className="inspector-body"><div className="inspector-title"><small><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time> · {event.source}</small><h2>{event.result}</h2><span>{label[phase]}</span></div><Track phase={phase} index={1} variant="full" live={phase === "active"} fresh={fresh} /><dl><div><dt>来源</dt><dd>{event.source}</dd></div><div><dt>状态</dt><dd>{label[phase]}</dd></div><div><dt>结果</dt><dd>{event.result}</dd></div><div><dt>后续操作</dt><dd>{event.nextStep}</dd></div></dl><section><b>原始 JSON</b><pre>{event.raw}</pre></section><button className="takeover" onClick={onTerminal}><TerminalSquare size={15} />打开终端</button></div></div></aside> : null}{restoreMounted ? <button className={`inspector-restore${motion === "opening" ? " is-retiring" : ""}`} ref={restoreRef} onClick={onToggle} aria-label="展开详情">{cornerIcon}<span className="inspector-tooltip" role="tooltip">展开详情</span></button> : null}</>;
}

createRoot(document.getElementById("root")!).render(<App />);
