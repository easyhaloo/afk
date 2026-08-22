import { useEffect, useMemo, useRef, useState } from "react";
/** AFK Control design: quiet local-operations shell; runtime cards are secondary to Timeline evidence and stay concise. */
import { createRoot } from "react-dom/client";
import {
  Activity, Archive, Bot, Boxes, Braces, Check, ChevronDown, CircleCheck, CircleDashed,
  CircleDot, Clock3, Command, Container, FolderOpen, LayoutList, RefreshCw,
  Send, Settings2, Sparkles, Terminal, TerminalSquare, TriangleAlert, Workflow, X,
} from "lucide-react";
import "./styles.css";
import "./timeline.css";
import "./runtime.css";
import "./replay.css";
import "./layout.css";
import "./palette.css";
import claudeIcon from "./assets/runtime-icons/claude-official.ico";
import codexIcon from "./assets/runtime-icons/codex-openai-official.png";
import geminiIcon from "./assets/runtime-icons/gemini-cli-official.png";
import openCodeIcon from "./assets/runtime-icons/opencode-official.svg";

type Phase = "ready" | "active" | "verify" | "attention";
type View = "queue" | "board" | "agents" | "containers" | "events";

const label: Record<Phase, string> = {
  ready: "待执行",
  active: "执行中",
  verify: "检查",
  attention: "待确认",
};

function phaseOf(event: RuntimeEvent): Phase {
  const text = `${event.source} ${event.result}`.toLowerCase();
  if (/error|fail|block|handoff|hitl/.test(text)) return "attention";
  if (/qa|verify|test|validate/.test(text)) return "verify";
  if (/start|run|agent|tool|exec/.test(text)) return "active";
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
  const [workspace, setWorkspace] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<RuntimeEvent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState("");
  const [terminal, setTerminal] = useState<{ open: boolean; pane: string }>({ open: false, pane: "" });
  const [line, setLine] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [replayRun, setReplayRun] = useState("");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const freshTimer = useRef<number | null>(null);
  const refreshInFlight = useRef(false);

  const refresh = async (target = workspace) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const next = await window.afkDesktop.snapshot(target);
      const priorIds = new Set(snapshot?.events.map((item) => item.id) ?? []);
      const addedIds = snapshot ? next.events.filter((item) => !priorIds.has(item.id)).map((item) => item.id) : [];
      setSnapshot(next);
      if (addedIds.length) {
        setFreshIds(new Set(addedIds));
        if (freshTimer.current) window.clearTimeout(freshTimer.current);
        freshTimer.current = window.setTimeout(() => setFreshIds(new Set()), 1400);
      }
      setWorkspace(next.workspace.root);
      setSelected((current) => next.events.find((item) => item.id === current?.id) ?? next.events[0] ?? null);
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
    setSession(name);
    setConfirmed(false);
    setTerminal({ open: true, pane: "正在读取 tmux 窗格…" });
    try {
      setTerminal({ open: true, pane: await window.afkDesktop.tmuxPane(name) });
    } catch (cause) {
      setTerminal({ open: true, pane: `无法读取会话：${String(cause)}` });
    }
  };

  const sendInput = async () => {
    if (!confirmed || !session || !line.trim()) return;
    try {
      await window.afkDesktop.tmuxSend(session, line);
      setLine("");
      setConfirmed(false);
      setTerminal({ open: true, pane: await window.afkDesktop.tmuxPane(session) });
    } catch (cause) {
      setTerminal((current) => ({ ...current, pane: `${current.pane}\n\n[发送失败] ${String(cause)}` }));
    }
  };

  const nav: Array<[View, string, typeof LayoutList]> = [
    ["queue", "运行队列", LayoutList],
    ["board", "运行看板", Workflow],
    ["agents", "Agent 检测", Activity],
    ["containers", "执行环境", Container],
    ["events", "运行回放", Archive],
  ];
  const title = nav.find(([key]) => key === view)?.[1] ?? "运行队列";
  const events = snapshot?.events ?? [];
  const runtimes = snapshot?.agentRuntimes ?? [];
  const availableRuntimeCount = runtimes.filter((runtime) => runtime.available).length;
  const runtimeTotal = runtimes.length || 4;
  const missingRuntimeCount = runtimes.filter((runtime) => runtime.status === "missing").length;
  const errorRuntimeCount = runtimes.filter((runtime) => runtime.status === "error").length;
  const activateView = (nextView: View) => {
    setView(nextView);
    if (nextView === "events" && selected) setReplayRun(selected.source);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">A</span><strong>AFK <b>/</b> CONTROL</strong><small>LOCAL OPERATIONS</small></div>
        <button className="workspace-switcher" onClick={() => void selectWorkspace()}>
          <span className="workspace-avatar">AF</span>
          <span><b>{snapshot?.workspace.root.split("/").pop() ?? "选择工作区"}</b><small>{snapshot?.workspace.afkDirectoryPresent ? ".afk 已发现" : "选择 AFK 工作区"}</small></span>
          <ChevronDown size={16} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>{nav.map(([key, text, Icon]) => <button key={key} className={view === key ? "nav-item active" : "nav-item"} onClick={() => activateView(key)}><Icon size={16} />{text}{key === "events" && events.length ? <em>{events.length}</em> : null}</button>)}</nav>
        <div className="nav-label lower">LOCAL</div>
        <div className="runtime-state"><i className={availableRuntimeCount ? "online" : "offline"} />{availableRuntimeCount ? `${availableRuntimeCount}/${runtimeTotal} 个 Agent 可用` : "未检测到 Agent"}</div>
        <button className="nav-item" onClick={() => void refresh()}><RefreshCw size={16} />刷新状态</button>
        <button className="nav-item" onClick={() => setView("containers")}><Boxes size={16} />容器</button>
        <div className="sidebar-footer"><span>{snapshot?.workspace.root ?? "本地工作区"}</span><small>{loading ? "刷新中…" : snapshot?.afk.summary ?? "等待连接"}</small></div>
      </aside>

      <section className="content-shell">
        <header className="topbar">
          <div className="breadcrumb"><span>AFK</span><b>›</b><strong>{title}</strong></div>
          <div className="top-actions"><button className="command" onClick={() => setCommandOpen((current) => !current)}><Command size={15} />命令 <kbd>⌘ K</kbd></button><button className="icon-button" onClick={() => void refresh()}><RefreshCw size={16} className={loading ? "spin" : ""} /></button><button className="loop" onClick={() => setView("agents")}><CircleDot size={15} />{availableRuntimeCount ? `${availableRuntimeCount} 个 Agent 可用` : "未检测到 Agent"}</button></div>
        </header>
        {commandOpen ? <div className="command-sheet"><header><span>命令</span><button onClick={() => setCommandOpen(false)}><X size={14} /></button></header><button onClick={() => { void refresh(); setCommandOpen(false); }}><RefreshCw size={14} />重新读取</button><button onClick={() => { setView("board"); setCommandOpen(false); }}><Workflow size={14} />打开看板</button><button onClick={() => { void selectWorkspace(); setCommandOpen(false); }}><FolderOpen size={14} />选择工作区</button></div> : null}
        {error ? <div className="error-banner"><X size={15} />{error}</div> : null}
        <div className="workspace">
          <header className="view-header"><div><span className="eyebrow"><i />AFK · LOCAL</span><h1>{title}</h1><p>{view === "agents" ? "检测本机 Agent CLI 的可用性、版本与路径" : "本地运行记录"}</p></div>{view === "agents" ? <AgentHeaderSummary available={availableRuntimeCount} total={runtimeTotal} missing={missingRuntimeCount} errors={errorRuntimeCount} checkedAt={lastCheckedAt} /> : <div className="view-stats"><span><i className="dot active" />{groups.active.length} 条执行中</span><span><i className="dot" />{groups.ready.length} 条待执行</span><span><i className="dot attention" />{groups.attention.length} 条待确认</span></div>}</header>
          {view === "queue" ? <Queue events={events} selected={selected} freshIds={freshIds} onSelect={setSelected} /> : null}
          {view === "board" ? <Board groups={groups} selected={selected} freshIds={freshIds} onSelect={setSelected} /> : null}
          {view === "agents" ? <Agents snapshot={snapshot} loading={loading} lastCheckedAt={lastCheckedAt} onRefresh={() => void refresh()} /> : null}
          {view === "containers" ? <Environments snapshot={snapshot} onTerminal={openSession} /> : null}
          {view === "events" ? <Replay events={events} selected={selected} freshIds={freshIds} activeRun={replayRun} onRunChange={setReplayRun} onSelect={setSelected} /> : null}
        </div>
        {selected && view !== "containers" ? <Inspector event={selected} fresh={freshIds.has(selected.id)} collapsed={inspectorCollapsed} onToggle={() => setInspectorCollapsed((current) => !current)} onTerminal={() => session && void openSession(session)} /> : null}
      </section>
      {terminal.open ? <TerminalSheet session={session} pane={terminal.pane} line={line} confirmed={confirmed} onClose={() => setTerminal((current) => ({ ...current, open: false }))} onLine={setLine} onConfirmed={setConfirmed} onSend={() => void sendInput()} /> : null}
    </main>
  );
}

function Queue({ events, selected, freshIds, onSelect }: { events: RuntimeEvent[]; selected: RuntimeEvent | null; freshIds: Set<string>; onSelect: (event: RuntimeEvent) => void }) {
  const phases: Phase[] = ["ready", "active", "verify", "attention"];
  if (!events.length) return <Empty />;
  return <section className="queue"><div className="list-head"><span>运行</span><span>阶段</span><span>状态</span></div>{phases.map((phase) => {
    const rows = events.filter((event) => phaseOf(event) === phase);
    if (!rows.length) return null;
    return <div className={`phase-group phase-${phase}`} key={phase}><header><span className={`status-dot ${phase}`} /><b>{label[phase]}</b><small>{rows.length.toString().padStart(2, "0")} 条记录</small><i /></header>{rows.map((event, index) => <EventRow key={event.id} event={event} index={index} fresh={freshIds.has(event.id)} selected={selected?.id === event.id} onSelect={onSelect} />)}</div>;
  })}<ArchiveBar /></section>;
}

function EventRow({ event, index, fresh, selected, onSelect }: { event: RuntimeEvent; index: number; fresh: boolean; selected: boolean; onSelect: (event: RuntimeEvent) => void }) {
  const phase = phaseOf(event);
  return <button className={`event-row ${selected ? "selected" : ""} ${phase}${fresh ? " fresh" : ""}`} onClick={() => onSelect(event)}><span className="event-icon"><Clock3 size={15} /></span><span className="event-copy"><span><b>{event.source}</b><strong>{event.result}</strong></span><small><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time> · {event.nextStep}</small></span><Track phase={phase} index={index} variant="compact" live={phase === "active" && index === 0} fresh={fresh} /><span className="event-state">{label[phase]}</span></button>;
}

function Board({ groups, selected, freshIds, onSelect }: { groups: Record<Phase, RuntimeEvent[]>; selected: RuntimeEvent | null; freshIds: Set<string>; onSelect: (event: RuntimeEvent) => void }) {
  const phases: Phase[] = ["ready", "active", "verify", "attention"];
  return <section className="board">{phases.map((phase) => <article className={`board-column ${phase}`} key={phase}><header><span className={`status-dot ${phase}`} /><b>{label[phase]}</b><em>{groups[phase].length}</em></header>{groups[phase].map((event, index) => <button className={`${selected?.id === event.id ? "board-card selected" : "board-card"}${freshIds.has(event.id) ? " fresh" : ""}`} key={event.id} onClick={() => onSelect(event)}><div><small><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time></small><b>{event.source}</b></div><strong>{event.result}</strong><p>→ {event.nextStep}</p><Track phase={phase} index={index} variant="card" live={phase === "active" && index === 0} fresh={freshIds.has(event.id)} /></button>)}{!groups[phase].length ? <p className="drop-note">暂无记录</p> : null}</article>)}</section>;
}

function RuntimeProductIcon({ id }: { id: AgentRuntime["id"] }) {
  const icons: Record<AgentRuntime["id"], string> = { claude: claudeIcon, codex: codexIcon, gemini: geminiIcon, opencode: openCodeIcon };
  return <span className={`runtime-product-icon ${id}`} aria-hidden="true"><img src={icons[id]} alt="" /></span>;
}

function RuntimeStatusIcon({ status, label }: { status: AgentRuntime["status"]; label: string }) {
  const icons = { available: CircleCheck, missing: CircleDashed, error: TriangleAlert };
  const Icon = icons[status];
  return <span className={`runtime-status-icon ${status}`} title={label} aria-label={`状态：${label}`}><Icon size={13} strokeWidth={2} /></span>;
}

function AgentHeaderSummary({ available, total, missing, errors, checkedAt }: { available: number; total: number; missing: number; errors: number; checkedAt: number | null }) {
  const time = checkedAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(checkedAt) : "尚未检测";
  return <div className="agent-header-summary" aria-label="Agent 检测摘要"><span className="agent-summary-available"><CircleCheck size={13} />{available}/{total} 可用</span>{missing ? <span className="agent-summary-missing"><CircleDashed size={13} />{missing} 未发现</span> : null}{errors ? <span className="agent-summary-error"><TriangleAlert size={13} />{errors} 需检查</span> : null}<span className="agent-summary-path">PATH 已解析</span><span className="agent-summary-time">检测 {time}</span></div>;
}

function Agents({ snapshot, loading, lastCheckedAt, onRefresh }: { snapshot: Snapshot | null; loading: boolean; lastCheckedAt: number | null; onRefresh: () => void }) {
  const runtimes = snapshot?.agentRuntimes ?? [];
  const available = runtimes.filter((runtime) => runtime.available).length;
  const statusLabel: Record<AgentRuntime["status"], string> = { available: "可调用", missing: "未发现", error: "需检查" };
  const checkedAt = lastCheckedAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(lastCheckedAt) : "尚未检测";
  return <section className="table-panel"><header><span>Agent 检测</span><span className="agent-count">PATH · {available}/{runtimes.length || 4}</span><button className={`runtime-refresh${loading ? " checking" : ""}`} disabled={loading} onClick={onRefresh}><Settings2 size={15} className={loading ? "spin" : ""} />{loading ? "正在检测…" : "重新检查"}</button></header><div className="agent-discovery-note"><span>claude · codex · gemini · opencode</span><small>{loading ? "正在重新检测 Agent…" : `上次检测 ${checkedAt}`}</small><b>{snapshot?.afk.available ? "afk 可用" : "未找到 afk"}</b></div><div className="agent-list">{runtimes.length ? runtimes.map((runtime) => <article className={`agent-runtime ${runtime.status}`} key={runtime.id}><RuntimeProductIcon id={runtime.id} /><RuntimeStatusIcon status={runtime.status} label={statusLabel[runtime.status]} /><div className="runtime-identity"><b>{runtime.label}</b><small title={runtime.executable || runtime.command}>{runtime.executable || runtime.command}</small></div><span className="runtime-summary" title={runtime.summary}>{runtime.summary}</span><strong>{statusLabel[runtime.status]}</strong></article>) : <p className="agent-empty"><b>{loading ? "正在读取 Agent 环境…" : "尚未检测 Agent"}</b><br />检查 Claude Code、Codex、Gemini CLI 和 OpenCode。</p>}</div></section>;
}

function Environments({ snapshot, onTerminal }: { snapshot: Snapshot | null; onTerminal: (name: string) => void }) {
  const containers = snapshot?.containers ?? [];
  const sessions = snapshot?.sessions ?? [];
  return <section className="environment-grid">
    <article><header><Container size={18} /><b>容器</b><span>{containers.length}</span></header>{containers.length ? containers.map((item) => <div className="env-row" key={`${item.engine}-${item.name}`}><span>{item.engine}</span><b>{item.name}</b><small>{item.image}</small><em>{item.status}</em></div>) : <p>没有正在运行的 Docker 或 Podman 容器。</p>}</article>
    <article><header><TerminalSquare size={18} /><b>tmux 会话</b><span>{sessions.length}</span></header>{sessions.length ? sessions.map((item) => <div className="env-row" key={item.name}><span>{item.attached ? "attached" : "detached"}</span><b>{item.name}</b><small>{item.windows} 个窗口</small><button onClick={() => onTerminal(item.name)}>打开终端</button></div>) : <p>没有可用的 tmux 会话。</p>}</article>
  </section>;
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

function Replay({ events, selected, freshIds, activeRun, onRunChange, onSelect }: { events: RuntimeEvent[]; selected: RuntimeEvent | null; freshIds: Set<string>; activeRun: string; onRunChange: (source: string) => void; onSelect: (event: RuntimeEvent) => void }) {
  if (!events.length) return <Empty />;
  const runs = replayRuns(events);
  const currentRun = runs.find((run) => run.source === activeRun) ?? runs[0];
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!currentRun) return <Empty />;
  const chronologicalEvents = currentRun.events;
  const latestId = currentRun.latest.id;
  const chooseRun = (source: string) => {
    const run = runs.find((item) => item.source === source);
    if (!run) return;
    onRunChange(run.source);
    onSelect(run.latest);
    setPickerOpen(false);
  };
  const currentPhase = phaseOf(currentRun.latest);
  return <section className="replay replay-minimal"><div className="replay-detail"><header><div className="replay-run-picker"><span className="replay-picker-label">运行</span><button className={`replay-picker-trigger ${pickerOpen ? "open" : ""}`} aria-haspopup="listbox" aria-controls="replay-run-options" aria-expanded={pickerOpen} onClick={() => setPickerOpen((current) => !current)} onKeyDown={(event) => { if (event.key === "Escape") setPickerOpen(false); if (event.key === "ArrowDown") setPickerOpen(true); }}><i className={`status-dot ${currentPhase}`} /><span><b>{currentRun.source}</b><small>{chronologicalEvents.length} 条记录</small></span><ChevronDown size={14} /></button>{pickerOpen ? <div className="replay-picker-popover" id="replay-run-options" role="listbox" aria-label="选择运行">{runs.map((run) => { const current = run.source === currentRun.source; const phase = phaseOf(run.latest); return <button className={`replay-picker-option ${phase}${current ? " selected" : ""}`} key={run.source} role="option" aria-selected={current} onClick={() => chooseRun(run.source)}><i className={`status-dot ${phase}`} /><span><b>{run.source}</b><small>{run.events.length} 条记录 · {replayTime(run.latest.timestamp)}</small></span>{current ? <Check size={13} /> : null}</button>; })}</div> : null}</div><div className="replay-run-summary"><span><i className={`status-dot ${currentPhase}`} />{label[currentPhase]}</span><b>{chronologicalEvents.length} 条记录</b></div></header><div className="replay-stream" aria-label={`${currentRun.source} 的运行记录，按时间排列`}>{chronologicalEvents.map((event, index) => {
    const phase = phaseOf(event);
    const live = event.id === latestId;
    const phaseBoundary = index === 0 || phase !== phaseOf(chronologicalEvents[index - 1]);
    return <button className={`replay-event ${phase}${selected?.id === event.id ? " selected" : ""}${freshIds.has(event.id) ? " fresh" : ""}${live ? " is-live" : ""}`} key={event.id} onClick={() => onSelect(event)} aria-current={selected?.id === event.id ? "step" : undefined}><span className="replay-axis"><time dateTime={event.timestamp} title={event.timestamp}>{replayTime(event.timestamp)}</time><span className="replay-spine" aria-hidden="true"><i className="replay-node" /></span></span><span className="replay-copy">{(phaseBoundary || live) ? <span className="replay-meta">{phaseBoundary ? <em>{label[phase]}</em> : null}{live ? <small>最新</small> : null}</span> : null}<strong>{event.result}</strong><small>→ {event.nextStep}</small></span></button>;
  })}</div></div></section>;
}

function Inspector({ event, fresh, collapsed, onToggle, onTerminal }: { event: RuntimeEvent; fresh: boolean; collapsed: boolean; onToggle: () => void; onTerminal: () => void }) {
  const phase = phaseOf(event);
  const toggleLabel = collapsed ? "展开详情" : "收起详情";
  return <aside className={`inspector${fresh ? " fresh" : ""}${collapsed ? " inspector-collapsed" : ""}`}><header><button className="inspector-toggle" onClick={onToggle} aria-label={toggleLabel}><svg className="inspector-corner-mark" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.5 3.5H5.6A1.1 1.1 0 0 0 4.5 4.6v6.9" /><path d="M8.8 3.5h2.7v2.7" /></svg><span className="inspector-tooltip" role="tooltip">{toggleLabel}</span></button><span><i className={`status-dot ${phase}`} />详情</span></header><div className="inspector-surface" aria-hidden={collapsed}><div className="inspector-body"><div className="inspector-title"><small><time dateTime={event.timestamp} title={event.timestamp}>{displayTimestamp(event.timestamp)}</time> · {event.source}</small><h2>{event.result}</h2><span>{label[phase]}</span></div><Track phase={phase} index={1} variant="full" live={phase === "active"} fresh={fresh} /><dl><div><dt>来源</dt><dd>{event.source}</dd></div><div><dt>状态</dt><dd>{label[phase]}</dd></div><div><dt>结果</dt><dd>{event.result}</dd></div><div><dt>后续操作</dt><dd>{event.nextStep}</dd></div></dl><section><b>原始 JSON</b><pre>{event.raw}</pre></section><button className="takeover" tabIndex={collapsed ? -1 : 0} onClick={onTerminal}><TerminalSquare size={15} />打开终端</button></div></div></aside>;
}

function TerminalSheet({ session, pane, line, confirmed, onClose, onLine, onConfirmed, onSend }: { session: string; pane: string; line: string; confirmed: boolean; onClose: () => void; onLine: (value: string) => void; onConfirmed: (value: boolean) => void; onSend: () => void }) {
  return <section className="terminal-sheet"><header><div><TerminalSquare size={17} /><strong>终端</strong><span>{session || "未选择 tmux 会话"}</span></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><pre>{pane || "没有可用的 tmux 会话。"}</pre><footer><label><input type="checkbox" checked={confirmed} onChange={(event) => onConfirmed(event.target.checked)} />确认发送到此 tmux 会话</label><div><input value={line} onChange={(event) => onLine(event.target.value)} placeholder="输入一行命令或文本" onKeyDown={(event) => { if (event.key === "Enter") onSend(); }} /><button className="send" disabled={!confirmed || !line.trim()} onClick={onSend}><Send size={15} />发送</button></div></footer></section>;
}

function ArchiveBar() { return <div className="archive"><span>LOCAL JSONL</span><Track phase="active" index={2} variant="archive" live /><p>选择一条记录查看详情</p></div>; }
function Empty() { return <div className="empty"><FolderOpen size={24} /><h2>没有运行记录</h2><p>选择包含 `.afk/runs` 的工作区后，记录会显示在这里。</p></div>; }

createRoot(document.getElementById("root")!).render(<App />);
