import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, Check, ChevronDown, ChevronRight, Copy, ExternalLink, FolderGit2, GitBranch, Hand, Link2, ListChecks, Play, Plus, RefreshCw, Search, ShieldAlert, Workflow, X } from "lucide-react";
import { Overlay } from "../../overlay";
import type { ReactNode } from "react";
import type {
  BacklogPlatform,
  GlobalWorkItem,
  WorkItemInventoryDiagnostic,
  WorkItemInventoryResult,
  WorkItemRepositoryRef,
  WorkItemRunRecord,
  WorkItemRunStartInput,
  WorkItemRunStartResult,
  WorkItemSourceRef,
  WorkItemAgentId,
  WorkItemTerminalId,
} from "../../../shared/backlog-contract";
import type { AgentRuntime } from "../../../shared/ipc-contract";
import { type ExecutionSummary } from "../../../shared/execution-contract";
import { RunTimelineView } from "../run-center/RunTimelineView";
import { useExecutionHistory } from "../run-center/use-execution-history";
import {
  planRepositoryCheckoutPaths,
  repositorySelectionKey,
  validateBaseBranch,
} from "../../../shared/work-item-run-validation";
import { SelectMenu } from "../../components/SelectMenu";
import { FilterPanel } from "../../components/FilterPanel";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ProviderIcon } from "../../components/ProviderIcon";
import { MarkdownContent } from "../backlog/MarkdownContent";
import "../backlog/backlog.css";
import "./work-items.css";

const emptyInventory: WorkItemInventoryResult = { items: [], projects: [], diagnostics: [], complete: true };
const pageSize = 50;

const stateLabels: Record<GlobalWorkItem["state"], string> = {
  ready: "待处理",
  rework: "返工",
  in_progress: "执行中",
  verification: "验证中",
  merge_ready: "待合并",
  done: "已完成",
  blocked: "已阻塞",
};

const executionModeLabels: Record<GlobalWorkItem["executionMode"], string> = {
  afk: "AFK 自动",
  hitl: "HITL 人工",
};

const stateFilterOptions: Array<{ value: GlobalWorkItem["state"] | "all"; label: string; triggerLabel?: string }> = [
  { value: "all", label: "全部状态", triggerLabel: "全部" },
  ...Object.entries(stateLabels).map(([value, label]) => ({ value: value as GlobalWorkItem["state"], label })),
];

const runStatusLabels: Record<WorkItemRunRecord["status"], string> = {
  starting: "准备中",
  running: "执行中",
  completed: "QA 待确认",
  failed: "失败",
};

const auditedRunLabels: Record<ExecutionSummary["status"], string> = {
  pending: "待执行", running: "执行中", awaiting_human: "等待人工处理",
  succeeded: "已完成", failed: "失败", cancelled: "已取消",
};
const auditedPhaseLabels: Record<NonNullable<ExecutionSummary["phase"]>, string> = {
  implementation: "实现", verification: "验证", release: "发布",
};

const terminalOptions: Array<{ value: WorkItemTerminalId; label: string }> = [
  { value: "iterm2", label: "iTerm2" },
  { value: "warp", label: "Warp" },
  { value: "ghostty", label: "Ghostty" },
  { value: "cmux", label: "cmux" },
  { value: "terminal", label: "Terminal.app" },
];

type DetailTab = "overview" | "plan" | "runs";
type RepositoryRunDraft = { selected: boolean; baseBranch: string };
type WorkItemRunView = { key: string; runId: string; startedAt?: string; status: string; statusLabel: string; summary?: string; actions?: ReactNode; metadata: ReactNode; log?: ReactNode };

function diagnosticTitle(diagnostic: WorkItemInventoryDiagnostic): string {
  return diagnostic.projectKey ? `${diagnostic.platform} · ${diagnostic.projectKey}` : diagnostic.platform;
}

function legacyIssueSource(item: GlobalWorkItem): WorkItemSourceRef {
  return {
    id: item.providerRef,
    type: item.project.platform === "github" ? "github_issue" : "gitlab_issue",
    title: item.title,
    reference: `${item.project.projectKey} #${item.issueNumber}`,
    role: "导入来源",
    platform: item.project.platform,
    projectKey: item.project.projectKey,
    issueNumber: item.issueNumber,
    webUrl: item.webUrl,
  };
}

function itemSources(item: GlobalWorkItem): WorkItemSourceRef[] {
  return item.sources === undefined ? [legacyIssueSource(item)] : item.sources;
}

function itemRepositories(item: GlobalWorkItem): WorkItemRepositoryRef[] {
  return item.repositories ?? [];
}

function executionRepositories(item: GlobalWorkItem): WorkItemRepositoryRef[] {
  if (item.repositories !== undefined) return item.repositories;
  return [{
    ...item.project,
    baseBranch: item.project.defaultBranch || "main",
  }];
}

function repositoryDraftKey(repository: WorkItemRepositoryRef): string {
  return repositorySelectionKey(repository);
}

function baseBranchError(value: string): string {
  try {
    validateBaseBranch(value);
    return "";
  } catch {
    return "Base 分支格式无效";
  }
}

function baseBranchErrorId(repository: WorkItemRepositoryRef): string {
  return `base-branch-error-${repositoryDraftKey(repository).replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

function workspacePath(item: GlobalWorkItem): string {
  const segments = item.id.split(/[:/#]+/).filter(Boolean);
  return `~/.loop-workspace/${segments.join("/")}/`;
}

function sourcePlatformLabel(source: WorkItemSourceRef): string {
  if (source.platform === "github" || source.type === "github_issue") return "Issue 来源";
  if (source.platform === "gitlab" || source.type === "gitlab_issue") return "Issue 来源";
  if (source.type === "local") return "本地创建";
  return "外部来源";
}

function sourcePlatformIcon(source: Pick<WorkItemSourceRef, "platform" | "type">): ReactNode {
  if (source.platform === "github" || source.type === "github_issue") return <ProviderIcon provider="github" size={13} />;
  if (source.platform === "gitlab" || source.type === "gitlab_issue") return <ProviderIcon provider="gitlab" size={13} />;
  return <Link2 size={13} aria-label="外部来源" />;
}

function sourceSummary(item: GlobalWorkItem): ReactNode {
  const sources = itemSources(item);
  if (!sources.length) return <span className="work-item-source-empty">无外部来源</span>;
  const first = sources[0];
  return <span className="work-item-source-summary"><span className={`work-item-platform-icon ${first.platform ?? first.type}`}>{sourcePlatformIcon(first)}</span><span>{first.reference}</span>{sources.length > 1 ? <small>等 {sources.length} 项</small> : null}</span>;
}

function repositorySummary(repositories: WorkItemRepositoryRef[]): string {
  if (!repositories.length) return "未关联代码仓库";
  if (repositories.length === 1) return repositories[0].name;
  return `${repositories[0].name} 等 ${repositories.length} 个仓库`;
}

function WorkItemEmptySection({ children }: { children: string }) {
  return <div className="work-item-section-empty">{children}</div>;
}

function RunStartTime({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span title={value}>开始时间不可用</span>;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <time dateTime={value} title={`本地时间（${timeZone}）`}>
    <span className="work-item-run-date">{date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span>{" "}
    <span className="work-item-run-clock">{date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}</span>
  </time>;
}

function WorkItemRunCard({ runId, startedAt, status, statusLabel, summary, selected, onSelect }: {
  runId: string; startedAt?: string; status: string; statusLabel: string; summary?: string;
  selected: boolean; onSelect: (button: HTMLButtonElement) => void;
}) {
  return <article className="work-item-run-card" data-run-id={runId} data-selected={selected}>
    <button type="button" className="work-item-run-heading" aria-pressed={selected} aria-controls="work-item-run-inspector" onClick={event => onSelect(event.currentTarget)}>
      <b>{startedAt ? <RunStartTime value={startedAt} /> : status === "pending" ? "等待开始" : "开始时间未记录"}</b>
      <span className="work-item-run-outcome">
        <em className={`work-item-run-result ${status}`}>{statusLabel}</em>
        {summary ? <span className={`work-item-run-summary ${status}`} title={summary}>{summary}</span> : null}
      </span>
      <ChevronRight className="work-item-run-arrow" size={14} aria-hidden="true" />
    </button>
  </article>;
}

function WorkItemRunInspector({ runId, startedAt, status, statusLabel, summary, metadata, actions, log, onBack }: {
  runId: string; startedAt?: string; status: string; statusLabel: string; summary?: string;
  metadata: ReactNode; actions?: ReactNode; log?: ReactNode; onBack: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyRunId = async () => {
    try {
      setCopyState(await window.afkDesktop.copyText(runId) ? "copied" : "failed");
    } catch {
      setCopyState("failed");
    }
  };
  return <section id="work-item-run-inspector" className="work-item-run-inspector" role="region" aria-label="运行详情" tabIndex={-1}>
    <button type="button" className="work-item-run-back" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />返回运行记录</button>
    <header className="work-item-run-inspector-heading">
      <div>
        <em className={`work-item-run-result ${status}`}>{statusLabel}</em>
        <h4>{startedAt ? <RunStartTime value={startedAt} /> : status === "pending" ? "等待开始" : "开始时间未记录"}</h4>
        {summary ? <p className={`work-item-run-inspector-summary ${status}`}>{summary}</p> : null}
      </div>
      <div className="work-item-run-actions">{actions}</div>
    </header>
    <section className="work-item-run-inspector-section"><h5>运行信息</h5><div className="work-item-run-inspector-meta">{metadata}<span>运行编号</span><div className="work-item-run-identity"><code title={runId}>{runId.replace(/^desktop-/, "").slice(0, 8)}</code><button type="button" aria-label={`复制运行 ${runId} 的完整编号`} title="复制完整编号" onClick={copyRunId}>{copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}</button></div></div>{copyState !== "idle" ? <span className="work-item-run-copy-notice" role="status">{copyState === "copied" ? "已复制" : "复制失败，请重试"}</span> : null}</section>
    {log ? <section className="work-item-run-inspector-section"><h5>执行时间线</h5>{log}</section> : null}
  </section>;
}

export function WorkItemsPage({ focusWorkItemId, agentRuntimes = [], defaultAgent = "claude-code", onAttach, onWorkflow, onCreate, onReviewMerge }: { focusWorkItemId?: string; agentRuntimes?: AgentRuntime[]; defaultAgent?: string; onAttach?: (runId: string) => void; onWorkflow?: (runId: string, workItemId: string) => void; onCreate?: () => void; onReviewMerge?: () => void } = {}) {
  const [inventory, setInventory] = useState<WorkItemInventoryResult>(emptyInventory);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<"all" | BacklogPlatform>("all");
  const [project, setProject] = useState("all");
  const [stateFilter, setStateFilter] = useState<GlobalWorkItem["state"] | "all">("ready");
  const [selectedItem, setSelected] = useState<GlobalWorkItem | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
  const [runDetailOpen, setRunDetailOpen] = useState(false);
  const runSelectionButton = useRef<HTMLButtonElement | null>(null);
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const [runError, setRunError] = useState("");
  const [startingRun, setStartingRun] = useState(false);
  const [foregroundAgent, setForegroundAgent] = useState<WorkItemAgentId>();
  const [foregroundTerminal, setForegroundTerminal] = useState<WorkItemTerminalId>("terminal");
  const [repositoryRunDrafts, setRepositoryRunDrafts] = useState<Record<string, RepositoryRunDraft>>({});
  const [visibleLimit, setVisibleLimit] = useState(pageSize);
  const requestVersion = useRef(0);
  const runRequestVersion = useRef(0);
  const selectedWorkItemId = useRef<string | null>(null);
  const lastFocusWorkItemId = useRef<string | null>(null);
  const selected = inventory.items.find(item => item.id === selectedItem?.id) ?? selectedItem;
  const { executions: auditedRuns, nextCursor: auditCursor, error: auditError, loadMore: loadMoreAuditedRuns } = useExecutionHistory(
    detailTab === "runs" && !!selected?.id && typeof window.afkDesktop.workItems.executions === "function", selected?.id,
  );

  const load = async (forceRefresh = false, silent = false) => {
    const version = ++requestVersion.current;
    if (!silent) { setLoading(true); setError(""); }
    try {
      const next = await window.afkDesktop.workItems.list(platform === "all" ? undefined : { platform }, ...(forceRefresh ? [true] : []));
      if (version === requestVersion.current) setInventory(next);
    } catch (cause) {
      if (version === requestVersion.current && !silent) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === requestVersion.current && !silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { requestVersion.current += 1; };
  }, [platform]);

  useEffect(() => {
    if (detailTab !== "runs" || !selected?.runs?.some(run => run.status === "starting" || run.status === "running")) return;
    const timer = setInterval(() => { void load(false, true); }, 3000);
    return () => clearInterval(timer);
  }, [detailTab, selected?.id, selected?.runs]);

  const projectOptions = useMemo(() => [
    { value: "all", label: "全部 Issue 来源", triggerLabel: "全部" },
    ...inventory.projects
      .filter(item => platform === "all" || item.platform === platform)
      .map(item => ({ value: `${item.platform}:${item.projectKey}`, label: item.projectKey })),
  ], [inventory.projects, platform]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = inventory.items.filter(item => {
      const sources = itemSources(item);
      const repositories = itemRepositories(item);
      if (platform !== "all" && !sources.some(source => source.platform === platform)) return false;
      if (project !== "all" && !sources.some(source => source.platform && `${source.platform}:${source.projectKey}` === project)) return false;
      if (stateFilter !== "all" && item.state !== stateFilter) return false;
      const searchable = [
        item.id,
        item.title,
        item.description ?? "",
        ...item.tags,
        ...sources.flatMap(source => [source.title, source.reference, source.role ?? ""]),
        ...repositories.flatMap(repository => [repository.name, repository.projectKey, repository.role ?? ""]),
      ].join(" ").toLowerCase();
      return !normalized || searchable.includes(normalized);
    });
    return filtered.sort((a, b) => {
      const aTime = a.updatedAt ?? "";
      const bTime = b.updatedAt ?? "";
      return bTime.localeCompare(aTime);
    });
  }, [inventory.items, platform, project, stateFilter, query]);

  const openDetails = (item: GlobalWorkItem) => {
    runRequestVersion.current += 1;
    selectedWorkItemId.current = item.id;
    setSelected(item);
    setDetailTab("overview");
    setSelectedRunKey(null);
    setRunDetailOpen(false);
    setRunSetupOpen(false);
    setRunNotice("");
    setRunError("");
    setStartingRun(false);
  };

  useEffect(() => {
    if (!focusWorkItemId || lastFocusWorkItemId.current === focusWorkItemId) return;
    const item = inventory.items.find(candidate => candidate.id === focusWorkItemId);
    if (!item) return;
    lastFocusWorkItemId.current = focusWorkItemId;
    openDetails(item);
  }, [focusWorkItemId, inventory.items]);

  const closeDetails = () => {
    runRequestVersion.current += 1;
    selectedWorkItemId.current = null;
    setStartingRun(false);
    setRunSetupOpen(false);
    setSelected(null);
  };

  const closeRunSetup = () => {
    runRequestVersion.current += 1;
    setStartingRun(false);
    setRunSetupOpen(false);
  };

  const selectedSources = selected ? itemSources(selected) : [];
  const selectedRepositories = selected ? itemRepositories(selected) : [];
  const availableExecutionRepositories = selected ? executionRepositories(selected) : [];
  const selectedPlan = selected?.executionPlan ?? [];
  const selectedRuns = selected?.runs ?? [];
  const runRecords: WorkItemRunView[] = [
    ...auditedRuns.map(run => ({
      key: `audit:${run.runId}`, runId: run.runId, startedAt: run.startedAt, status: run.status, statusLabel: auditedRunLabels[run.status],
      summary: run.phase ? `${auditedPhaseLabels[run.phase]}阶段` : undefined,
      actions: <>{onWorkflow ? <button type="button" aria-label={`查看运行 ${run.runId} 的工作流实例`} title="工作流实例" onClick={() => onWorkflow(run.runId, run.workItemId)}><Workflow size={14} /></button> : null}{onAttach && !run.terminal ? <button type="button" onClick={() => onAttach(run.runId)}>接管</button> : null}</>,
      metadata: <><span>来源</span><b>运行审计</b><span>执行尝试</span><b>{run.attempt} · 事件序号 {run.sequence}</b></>,
      log: typeof window.afkDesktop.workItems.executionRunDetail === "function" ? <RunTimelineView runId={run.runId} workItemId={run.workItemId} expanded running={run.status === "running"} load={(id, itemId) => window.afkDesktop.workItems.executionRunDetail(id, itemId)} /> : undefined,
    })),
    ...selectedRuns.map(run => ({
      key: `launch:${run.id}`, runId: run.id, startedAt: run.startedAt, status: run.status, statusLabel: runStatusLabels[run.status],
      summary: run.status === "failed" ? run.error?.trim() : undefined,
      metadata: <><span>来源</span><b>启动记录</b>{run.workflow?.trim() ? <><span>工作流</span><b>{run.workflow}</b></> : null}{run.status === "failed" && !run.error?.trim() ? <><span>失败原因</span><b>未记录</b></> : null}{run.workspacePath ? <><span>工作目录</span><code title={run.workspacePath}>{run.workspacePath}</code></> : null}</>,
    })),
  ];
  runRecords.sort((left, right) => (Date.parse(right.startedAt ?? "") || 0) - (Date.parse(left.startedAt ?? "") || 0));
  const activeRun = runRecords.find(run => run.key === selectedRunKey) ?? runRecords[0];
  const returnToRunList = () => {
    setRunDetailOpen(false);
    requestAnimationFrame(() => runSelectionButton.current?.focus());
  };
  const remainingItems = Math.max(0, visibleItems.length - visibleLimit);
  const selectedExecutionRepositories = availableExecutionRepositories.filter(repository => repositoryRunDrafts[repositoryDraftKey(repository)]?.selected);
  const selectedCheckoutPaths = planRepositoryCheckoutPaths(selectedExecutionRepositories);
  const availableCheckoutPaths = planRepositoryCheckoutPaths(availableExecutionRepositories);
  const selectedCheckoutPathByKey = new Map(selectedExecutionRepositories.map((repository, index) => [repositoryDraftKey(repository), selectedCheckoutPaths[index]]));
  const availableCheckoutPathByKey = new Map(availableExecutionRepositories.map((repository, index) => [repositoryDraftKey(repository), availableCheckoutPaths[index]]));
  const hasInvalidSelectedBranch = selectedExecutionRepositories.some(repository => baseBranchError(repositoryRunDrafts[repositoryDraftKey(repository)].baseBranch));
  const availableAgents = agentRuntimes.filter(runtime => runtime.available);
  const canStartRun = !startingRun && selectedExecutionRepositories.length > 0 && !hasInvalidSelectedBranch && (selected?.executionMode !== "hitl" || foregroundAgent !== undefined);

  const openRunSetup = () => {
    runRequestVersion.current += 1;
    setRunError("");
    setStartingRun(false);
    setRepositoryRunDrafts(Object.fromEntries(availableExecutionRepositories.map(repository => [
      repositoryDraftKey(repository),
      { selected: true, baseBranch: repository.defaultBranch ?? "main" },
    ])));
    const preferredAgent = availableAgents.find(runtime => runtime.id === defaultAgent || (defaultAgent === "claude-code" && runtime.id === "claude")) ?? availableAgents[0];
    setForegroundAgent(preferredAgent?.id);
    setForegroundTerminal("terminal");
    setRunSetupOpen(true);
  };

  const startRun = async () => {
    if (!selected || !canStartRun) return;
    const workItemId = selected.id;
    const currentRequestVersion = ++runRequestVersion.current;
    const selectedRepositories = [...selectedExecutionRepositories];
    const checkoutPaths = planRepositoryCheckoutPaths(selectedRepositories);
    const repositories = selectedRepositories.map((repository, index) => {
      const key = repositoryDraftKey(repository);
      return {
        platform: repository.platform,
        projectKey: repository.projectKey,
        ...(repository.providerHost === undefined ? {} : { providerHost: repository.providerHost }),
        ...(repository.providerProjectId === undefined ? {} : { providerProjectId: repository.providerProjectId }),
        name: repository.name,
        checkoutPath: checkoutPaths[index],
        baseBranch: validateBaseBranch(repositoryRunDrafts[key].baseBranch),
        ...(repository.role === undefined ? {} : { role: repository.role }),
      };
    });
    const input: WorkItemRunStartInput = {
      workItemId,
      repositories,
      environment: "local",
      ...(selected.executionMode === "hitl" && foregroundAgent ? { foreground: { agent: foregroundAgent, terminal: foregroundTerminal } } : {}),
    };
    setStartingRun(true);
    setRunError("");
    try {
      const result: WorkItemRunStartResult = await window.afkDesktop.workItems.start(input);
      if (runRequestVersion.current !== currentRequestVersion || selectedWorkItemId.current !== workItemId) return;
      setRunNotice(`运行已创建：${result.workspace.root}`);
      setRunSetupOpen(false);
      setDetailTab("runs");
      void load(false, true);
    } catch (cause) {
      if (runRequestVersion.current !== currentRequestVersion || selectedWorkItemId.current !== workItemId) return;
      setRunError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (runRequestVersion.current === currentRequestVersion && selectedWorkItemId.current === workItemId) setStartingRun(false);
    }
  };

  return (
    <section className="backlog-page work-items-page">
      <div className="control-page-heading backlog-heading">
        <div><p>工作项</p><span>工作项是独立任务；Issue 是可选外部来源，代码仓库是按需关联的执行资源。</span></div>
        <div className="work-items-heading-actions">
          {onCreate ? <button type="button" className="work-items-create" aria-label="创建工作项" title="创建工作项" onClick={onCreate}><Plus size={14} />创建</button> : null}
          <button type="button" className="work-items-refresh" aria-label="刷新工作项" title="刷新工作项" disabled={loading} onClick={() => void load(true)}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
        </div>
      </div>
      {error ? <div className="backlog-alert error"><ShieldAlert size={15} />{error}</div> : null}
      {inventory.diagnostics.length ? <div className="work-item-diagnostics">{inventory.diagnostics.map((diagnostic, index) => <div key={`${diagnostic.platform}-${diagnostic.projectKey ?? "provider"}-${index}`}><b>{diagnosticTitle(diagnostic)}</b><span>{diagnostic.message}</span></div>)}</div> : null}

      <SegmentedControl label="工作项快捷状态" value={stateFilter} options={[{ value: "all", label: "全部", count: inventory.items.length }, { value: "ready", label: "待处理", count: inventory.items.filter(item => item.state === "ready").length }, { value: "in_progress", label: "执行中", count: inventory.items.filter(item => item.state === "in_progress").length }, { value: "done", label: "已完成", count: inventory.items.filter(item => item.state === "done").length }]} onChange={value => { setStateFilter(value as GlobalWorkItem["state"] | "all"); setVisibleLimit(pageSize); }} />
      <div className="backlog-toolbar work-items-toolbar">
        <label className="backlog-search"><Search size={14} /><input aria-label="搜索工作项" value={query} onChange={event => { setQuery(event.target.value); setVisibleLimit(pageSize); }} placeholder="搜索标题、来源、关联仓库或标签" /></label>
        <FilterPanel label="筛选工作项" filters={[
          ...(platform !== "all" ? [{ key: "platform", label: `来源：${platform === "github" ? "GitHub" : "GitLab"}`, onClear: () => { setPlatform("all"); setProject("all"); setVisibleLimit(pageSize); } }] : []),
          ...(project !== "all" ? [{ key: "project", label: `Issue：${projectOptions.find(option => option.value === project)?.label ?? project}`, onClear: () => { setProject("all"); setVisibleLimit(pageSize); } }] : []),
          ...(stateFilter !== "all" ? [{ key: "state", label: `状态：${stateLabels[stateFilter]}`, onClear: () => { setStateFilter("all"); setVisibleLimit(pageSize); } }] : []),
        ]}>
        <SelectMenu label="选择 Provider" value={platform} variant="filter" triggerPrefix="来源" options={[{ value: "all", label: "全部来源平台", triggerLabel: "全部" }, { value: "github", label: "GitHub", icon: "github", triggerLabel: "GitHub" }, { value: "gitlab", label: "GitLab", icon: "gitlab", triggerLabel: "GitLab" }]} onChange={value => { setPlatform(value as "all" | BacklogPlatform); setProject("all"); setVisibleLimit(pageSize); }} />
        <SelectMenu label="选择仓库" value={project} variant="filter" triggerPrefix="Issue" search={{ label: "搜索 Issue 来源", pinnedValue: "all", emptyMessage: "没有匹配的 Issue 来源" }} options={projectOptions} onChange={value => { setProject(value); setVisibleLimit(pageSize); }} />
        <SelectMenu label="筛选状态" value={stateFilter} variant="filter" triggerPrefix="状态" options={stateFilterOptions} onChange={value => { setStateFilter(value as GlobalWorkItem["state"] | "all"); setVisibleLimit(pageSize); }} />
        </FilterPanel>
      </div>

      <div className="backlog-list">
        {visibleItems.length ? visibleItems.slice(0, visibleLimit).map(item => {
          const sources = itemSources(item);
          const repositories = itemRepositories(item);
          return (
            <article key={item.id} className="backlog-row work-item-row" onClick={() => openDetails(item)}>
              <span className={`backlog-mode-mark is-${item.executionMode}`} aria-label={executionModeLabels[item.executionMode]} title={executionModeLabels[item.executionMode]}>{item.executionMode === "afk" ? <Bot size={15} aria-hidden="true" /> : <Hand size={15} aria-hidden="true" />}</span>
              <div className="backlog-row-body">
                <header><b>{item.title}</b></header>
                <div className="work-item-row-context"><span>{sourceSummary(item)}</span><span><FolderGit2 size={12} />{repositorySummary(repositories)}</span></div>
                <div className="backlog-item-metadata">
                  <span className={`backlog-state-label backlog-state-${item.state}`}>{stateLabels[item.state]}</span>
                  <span className={`backlog-mode-tag is-${item.executionMode}`}>{executionModeLabels[item.executionMode]}</span>
                  <span className={item.managed ? "work-item-managed" : "work-item-unmanaged"}>{item.managed ? item.executionEligible ? "可执行" : "已管理" : "待导入"}</span>
                  <span className="work-item-count">{sources.length} 个来源</span>
                  <span className="work-item-count">{repositories.length} 个关联仓库</span>
                  {item.tags.map(tag => <span className="backlog-tag" key={tag}>{tag}</span>)}
                </div>
              </div>
            </article>
          );
        }) : <div className="backlog-empty"><b>{loading ? "正在读取全局工作项…" : "没有匹配的工作项"}</b><span>{loading ? "工作项发现不依赖当前打开目录。" : "请检查来源平台鉴权或调整筛选条件。"}</span></div>}
      </div>
      {remainingItems > 0 ? <div className="work-items-load-more"><span>还有 {remainingItems} 个</span><button type="button" aria-label="显示更多工作项" onClick={() => setVisibleLimit(limit => limit + pageSize)}>继续加载 <ChevronDown size={13} /></button></div> : null}

      {selected ? (<Overlay>
        <div className="work-item-detail-layer" data-runs={detailTab === "runs"} onMouseDown={event => { if (event.target === event.currentTarget) closeDetails(); }}>
          <aside className="work-item-detail" data-runs={detailTab === "runs"} role="dialog" aria-modal={detailTab !== "runs"} aria-label={`工作项 ${selected.id}`}>
            <header className="work-item-detail-header">
              <div><small className="work-item-detail-id"><ProviderIcon provider={selected.project.platform ?? selected.sources?.[0]?.platform} size={11} />{selected.issueNumber ? `${selected.project.projectKey} #${selected.issueNumber}` : selected.id} · {executionModeLabels[selected.executionMode]} · {selected.executionEligible ? "可执行" : "不可执行"}</small><h2>{selected.title}</h2><p>{[selected.owner ? `负责人：${selected.owner}` : "", selected.priority ? `优先级 ${selected.priority}` : "", selected.updatedAt ? `更新于 ${selected.updatedAt}` : ""].filter(Boolean).join(" · ") || "独立工作项"}</p></div>
              <button type="button" aria-label="关闭工作项详情" onClick={closeDetails}><X size={16} /></button>
            </header>
            <nav className="work-item-detail-tabs" aria-label="工作项详情分区">
              <button type="button" className={detailTab === "overview" ? "active" : ""} aria-pressed={detailTab === "overview"} onClick={() => setDetailTab("overview")}>概览</button>
              <button type="button" className={detailTab === "plan" ? "active" : ""} aria-pressed={detailTab === "plan"} onClick={() => setDetailTab("plan")}>执行计划 <span>{selectedPlan.length}</span></button>
              <button type="button" className={detailTab === "runs" ? "active" : ""} aria-pressed={detailTab === "runs"} onClick={() => setDetailTab("runs")}>运行记录 <span>{selectedRuns.length + auditedRuns.length}</span></button>
            </nav>
            <div className="work-item-detail-body">
              {detailTab === "overview" ? <>
                <section className="work-item-detail-section"><div className="work-item-section-heading"><h3>目标</h3></div><div className="backlog-detail-description work-item-detail-description">{selected.description?.trim() ? <MarkdownContent source={selected.description} /> : "该工作项尚未补充目标描述。"}</div></section>
                <section className="work-item-detail-section">
                  <div className="work-item-section-heading"><h3>外部来源</h3><small>{selectedSources.length} 个引用，不决定工作项归属</small></div>
                  {selectedSources.length ? selectedSources.map(source => (
                    <button key={source.id} type="button" className="work-item-reference-card" disabled={!source.webUrl} onClick={() => source.webUrl && void window.afkDesktop.openExternal(source.webUrl)}>
                      <span className={`work-item-reference-icon ${source.platform ?? source.type}`}>{sourcePlatformIcon(source)}</span>
                      <span className="work-item-reference-copy"><b>{source.reference}</b><small>{source.title}</small></span>
                      <span className="work-item-role">{source.role ?? sourcePlatformLabel(source)}</span>{source.webUrl ? <ExternalLink size={13} /> : null}
                    </button>
                  )) : <WorkItemEmptySection>没有外部来源；工作项仍可独立存在。</WorkItemEmptySection>}
                </section>
                <section className="work-item-detail-section">
                  <div className="work-item-section-heading"><h3>关联资源</h3><small>{selectedRepositories.length} 个代码仓库，运行时独立检出</small></div>
                  {selectedRepositories.length ? selectedRepositories.map(repository => (
                    <div className="work-item-reference-card" key={repository.id ?? `${repository.platform}:${repository.projectKey}`}><span className="work-item-reference-icon repository"><GitBranch size={14} /></span><span className="work-item-reference-copy"><b>{repository.name}</b><small>{repository.checkoutPath ?? `repositories/${repository.name}`} · {repository.defaultBranch ?? "默认分支"}</small></span><span className="work-item-role">{repository.role ?? "代码仓库"}</span></div>
                  )) : <WorkItemEmptySection>尚未关联代码仓库；开始执行前可按需配置 0..N 个资源。</WorkItemEmptySection>}
                </section>
              </> : null}

              {detailTab === "plan" ? <section className="work-item-detail-section">
                <div className="work-item-section-heading"><h3>执行计划</h3><small>计划属于工作项，不属于任一仓库</small></div>
                {selectedPlan.length ? selectedPlan.map((step, index) => <div className="work-item-plan-card" key={step.id}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{step.title}</b><small>{step.detail ?? "待补充执行说明"}</small></div><em className={step.status ?? "pending"}>{step.status === "completed" ? "已完成" : step.status === "running" ? "执行中" : step.status === "blocked" ? "阻塞" : "待执行"}</em></div>) : <WorkItemEmptySection>尚未生成执行计划；可在开始执行时选择工作流。</WorkItemEmptySection>}
              </section> : null}

              {detailTab === "runs" ? <section className="work-item-detail-section work-item-run-history" data-detail-open={runDetailOpen}>
                <div className="work-item-section-heading"><h3>运行记录</h3></div>
                {auditError ? <div className="work-item-run-error">运行审计查询失败：{auditError}</div> : null}
                {runRecords.length ? <div className="work-item-run-split">
                  <div className="work-item-run-list" role="group" aria-label="运行记录列表">
                    {runRecords.map(({ key, ...run }) => <WorkItemRunCard key={key} {...run} selected={key === activeRun?.key} onSelect={button => {
                      runSelectionButton.current = button;
                      setSelectedRunKey(key);
                      setRunDetailOpen(true);
                      if (button) requestAnimationFrame(() => { if (button.offsetParent === null) document.getElementById("work-item-run-inspector")?.focus(); });
                    }} />)}
                    {auditCursor ? <button type="button" className="work-item-run-more" onClick={() => void loadMoreAuditedRuns()}>查看更多运行记录</button> : null}
                  </div>
                  {activeRun ? <WorkItemRunInspector key={activeRun.key} runId={activeRun.runId} startedAt={activeRun.startedAt} status={activeRun.status} statusLabel={activeRun.statusLabel} summary={activeRun.summary} metadata={activeRun.metadata} actions={activeRun.actions} log={activeRun.log} onBack={returnToRunList} /> : null}
                </div> : null}
                {!runRecords.length ? <WorkItemEmptySection>暂无运行记录。</WorkItemEmptySection> : null}
              </section> : null}
            </div>
            <footer className="work-item-detail-footer">
              <div><small>运行不会使用当前打开目录</small><code>{workspacePath(selected)}</code>{runNotice ? <span>{runNotice}</span> : null}</div>
              {selected.state === "merge_ready" && onReviewMerge ? <button type="button" className="work-item-secondary-action" onClick={onReviewMerge}>处理合并</button> : null}
              <button type="button" className="work-item-primary-action" disabled={!selected.executionEligible} onClick={openRunSetup}><Play size={14} />开始执行</button>
            </footer>
          </aside>
        </div>
      </Overlay>) : null}

      {selected && runSetupOpen ? (<Overlay>
        <div className="work-item-run-modal-layer" onMouseDown={event => { if (event.target === event.currentTarget) closeRunSetup(); }}>
          <section className="work-item-run-modal" role="dialog" aria-modal="true" aria-label="开始执行工作项">
            <header><div><h2>开始执行工作项</h2><p>确认执行资源和隔离任务空间。</p></div><button type="button" aria-label="关闭执行配置" onClick={closeRunSetup}><X size={16} /></button></header>
            <div className="work-item-run-modal-body">
              <div className="work-item-run-field"><span>执行模式</span><b>{selected.executionMode === "hitl" ? <Hand size={14} /> : <Bot size={14} />}{executionModeLabels[selected.executionMode]}</b></div>
              {selected.executionMode === "hitl" ? <>
                <label className="work-item-run-field"><span>选择 Agent</span><select aria-label="选择 Agent" value={foregroundAgent ?? ""} onChange={event => setForegroundAgent(event.target.value as WorkItemAgentId)}><option value="" disabled>没有可用 Agent</option>{availableAgents.map(agent => <option value={agent.id} key={agent.id}>{agent.label} · {agent.command}</option>)}</select></label>
                <label className="work-item-run-field"><span>选择终端</span><select aria-label="选择终端" value={foregroundTerminal} onChange={event => setForegroundTerminal(event.target.value as WorkItemTerminalId)}>{terminalOptions.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
                <div className="work-item-run-field"><span>执行方式</span><b><Hand size={14} />在选定终端前台启动 Agent</b></div>
              </> : <>
                <div className="work-item-run-field"><span>执行工作流</span><b><ListChecks size={14} />标准研发流程</b></div>
                <div className="work-item-run-field"><span>执行环境</span><b><Bot size={14} />本地隔离环境</b></div>
              </>}
              <section className="work-item-run-resources"><div className="work-item-section-heading"><h3>本次运行使用的代码仓库</h3><small>{availableExecutionRepositories.length} 个</small></div>{availableExecutionRepositories.length ? availableExecutionRepositories.map(repository => {
                const key = repositoryDraftKey(repository);
                const draft = repositoryRunDrafts[key] ?? { selected: false, baseBranch: "" };
                const branchError = draft.selected ? baseBranchError(draft.baseBranch) : "";
                const errorId = baseBranchErrorId(repository);
                const checkoutPath = selectedCheckoutPathByKey.get(key) ?? availableCheckoutPathByKey.get(key);
                return <div className={`work-item-run-repository${draft.selected ? " selected" : ""}`} key={key}>
                  <input aria-label={`选择仓库：${repository.name}`} type="checkbox" checked={draft.selected} onChange={event => setRepositoryRunDrafts(current => ({ ...current, [key]: { ...current[key], selected: event.target.checked } }))} />
                  <span className="work-item-run-repository-copy"><b>{repository.name}</b><small>{repository.projectKey} · {checkoutPath}</small></span>
                  <em>{repository.role ?? (selected.repositories?.length ? "资源" : "兼容来源仓库")}</em>
                  <label className="work-item-base-branch"><span>Base 分支</span><input aria-label={`Base 分支：${repository.name}`} aria-invalid={Boolean(branchError)} aria-describedby={branchError ? errorId : undefined} value={draft.baseBranch} onChange={event => setRepositoryRunDrafts(current => ({ ...current, [key]: { ...current[key], baseBranch: event.target.value } }))} /></label>
                  {branchError ? <small className="work-item-base-branch-error" id={errorId}>{branchError}</small> : null}
                </div>;
              }) : <WorkItemEmptySection>本工作项没有可用于运行的代码仓库。</WorkItemEmptySection>}</section>
              <div className="work-item-workspace-preview"><FolderGit2 size={18} /><div><b>系统将创建独立任务空间</b><code>{workspacePath(selected)}{"{repositories,runtime,artifacts,logs,diagnostics}"}</code></div></div>
              {runError ? <div className="work-item-run-error"><ShieldAlert size={14} />{runError}</div> : null}
            </div>
            <footer><button type="button" className="work-item-secondary-action" disabled={startingRun} onClick={closeRunSetup}>取消</button><button type="button" className="work-item-primary-action" disabled={!canStartRun} onClick={() => void startRun()}><Play size={14} />{startingRun ? "正在启动…" : selected.executionMode === "hitl" ? "开始前台执行" : "创建运行"}</button></footer>
          </section>
        </div>
      </Overlay>) : null}
    </section>
  );
}
