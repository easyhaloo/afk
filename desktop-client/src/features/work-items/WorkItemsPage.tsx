import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ExternalLink, FolderGit2, GitBranch, History, Link2, ListChecks, Play, RefreshCw, Search, ShieldAlert, X } from "lucide-react";
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
} from "../../../shared/backlog-contract";
import {
  planRepositoryCheckoutPaths,
  repositorySelectionKey,
  validateBaseBranch,
} from "../../../shared/work-item-run-validation";
import { SelectMenu } from "../../components/SelectMenu";
import { ProviderIcon } from "../../components/ProviderIcon";
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

const runStatusLabels: Record<WorkItemRunRecord["status"], string> = {
  starting: "准备中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
};

type DetailTab = "overview" | "plan" | "runs";
type RepositoryRunDraft = { selected: boolean; baseBranch: string };

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

export function WorkItemsPage() {
  const [inventory, setInventory] = useState<WorkItemInventoryResult>(emptyInventory);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<"all" | BacklogPlatform>("all");
  const [project, setProject] = useState("all");
  const [selectedItem, setSelected] = useState<GlobalWorkItem | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const [runError, setRunError] = useState("");
  const [startingRun, setStartingRun] = useState(false);
  const [repositoryRunDrafts, setRepositoryRunDrafts] = useState<Record<string, RepositoryRunDraft>>({});
  const [visibleLimit, setVisibleLimit] = useState(pageSize);
  const requestVersion = useRef(0);
  const runRequestVersion = useRef(0);
  const selectedWorkItemId = useRef<string | null>(null);
  const selected = inventory.items.find(item => item.id === selectedItem?.id) ?? selectedItem;

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
    return inventory.items.filter(item => {
      const sources = itemSources(item);
      const repositories = itemRepositories(item);
      if (platform !== "all" && !sources.some(source => source.platform === platform)) return false;
      if (project !== "all" && !sources.some(source => source.platform && `${source.platform}:${source.projectKey}` === project)) return false;
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
  }, [inventory.items, platform, project, query]);

  const openDetails = (item: GlobalWorkItem) => {
    runRequestVersion.current += 1;
    selectedWorkItemId.current = item.id;
    setSelected(item);
    setDetailTab("overview");
    setRunSetupOpen(false);
    setRunNotice("");
    setRunError("");
    setStartingRun(false);
  };

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
  const remainingItems = Math.max(0, visibleItems.length - visibleLimit);
  const selectedExecutionRepositories = availableExecutionRepositories.filter(repository => repositoryRunDrafts[repositoryDraftKey(repository)]?.selected);
  const selectedCheckoutPaths = planRepositoryCheckoutPaths(selectedExecutionRepositories);
  const availableCheckoutPaths = planRepositoryCheckoutPaths(availableExecutionRepositories);
  const selectedCheckoutPathByKey = new Map(selectedExecutionRepositories.map((repository, index) => [repositoryDraftKey(repository), selectedCheckoutPaths[index]]));
  const availableCheckoutPathByKey = new Map(availableExecutionRepositories.map((repository, index) => [repositoryDraftKey(repository), availableCheckoutPaths[index]]));
  const hasInvalidSelectedBranch = selectedExecutionRepositories.some(repository => baseBranchError(repositoryRunDrafts[repositoryDraftKey(repository)].baseBranch));
  const canStartRun = !startingRun && selectedExecutionRepositories.length > 0 && !hasInvalidSelectedBranch;

  const openRunSetup = () => {
    runRequestVersion.current += 1;
    setRunError("");
    setStartingRun(false);
    setRepositoryRunDrafts(Object.fromEntries(availableExecutionRepositories.map(repository => [
      repositoryDraftKey(repository),
      { selected: true, baseBranch: repository.defaultBranch ?? "main" },
    ])));
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
    const input: WorkItemRunStartInput = { workItemId, repositories, environment: "local" };
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
        <button type="button" className="work-items-refresh" aria-label="刷新工作项" title="刷新工作项" disabled={loading} onClick={() => void load(true)}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
      </div>
      {error ? <div className="backlog-alert error"><ShieldAlert size={15} />{error}</div> : null}
      {inventory.diagnostics.length ? <div className="work-item-diagnostics">{inventory.diagnostics.map((diagnostic, index) => <div key={`${diagnostic.platform}-${diagnostic.projectKey ?? "provider"}-${index}`}><b>{diagnosticTitle(diagnostic)}</b><span>{diagnostic.message}</span></div>)}</div> : null}

      <div className="backlog-toolbar work-items-toolbar">
        <label className="backlog-search"><Search size={14} /><input aria-label="搜索工作项" value={query} onChange={event => { setQuery(event.target.value); setVisibleLimit(pageSize); }} placeholder="搜索标题、来源、关联仓库或标签" /></label>
        <SelectMenu label="选择 Provider" value={platform} variant="filter" triggerPrefix="来源" options={[{ value: "all", label: "全部来源平台", triggerLabel: "全部" }, { value: "github", label: "GitHub", icon: "github", triggerLabel: "GitHub" }, { value: "gitlab", label: "GitLab", icon: "gitlab", triggerLabel: "GitLab" }]} onChange={value => { setPlatform(value as "all" | BacklogPlatform); setProject("all"); setVisibleLimit(pageSize); }} />
        <SelectMenu label="选择仓库" value={project} variant="filter" triggerPrefix="Issue" search={{ label: "搜索 Issue 来源", pinnedValue: "all", emptyMessage: "没有匹配的 Issue 来源" }} options={projectOptions} onChange={value => { setProject(value); setVisibleLimit(pageSize); }} />
      </div>

      <div className="backlog-list">
        {visibleItems.length ? visibleItems.slice(0, visibleLimit).map(item => {
          const sources = itemSources(item);
          const repositories = itemRepositories(item);
          return (
            <article key={item.id} className="backlog-row work-item-row" onClick={() => openDetails(item)}>
              <span className={`backlog-mode-mark ${item.executionMode === "afk" ? "is-afk" : "is-hitl"}`}><Bot size={15} /></span>
              <div className="backlog-row-body">
                <header><b>{item.title}</b></header>
                <div className="work-item-row-context"><span>{sourceSummary(item)}</span><span><FolderGit2 size={12} />{repositorySummary(repositories)}</span></div>
                <div className="backlog-item-metadata">
                  <span className={`backlog-state-label backlog-state-${item.state}`}>{stateLabels[item.state]}</span>
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

      {selected ? (
        <div className="work-item-detail-layer" onMouseDown={event => { if (event.target === event.currentTarget) closeDetails(); }}>
          <aside className="work-item-detail" role="dialog" aria-modal="true" aria-label={`工作项 ${selected.id}`}>
            <header className="work-item-detail-header">
              <div><small>{selected.id} · {selected.executionEligible ? "可执行" : "不可执行"}</small><h2>{selected.title}</h2><p>{[selected.owner ? `负责人：${selected.owner}` : "", selected.priority ? `优先级 ${selected.priority}` : "", selected.updatedAt ? `更新于 ${selected.updatedAt}` : ""].filter(Boolean).join(" · ") || "独立工作项"}</p></div>
              <button type="button" aria-label="关闭工作项详情" onClick={closeDetails}><X size={16} /></button>
            </header>
            <nav className="work-item-detail-tabs" aria-label="工作项详情分区">
              <button type="button" className={detailTab === "overview" ? "active" : ""} aria-pressed={detailTab === "overview"} onClick={() => setDetailTab("overview")}>概览</button>
              <button type="button" className={detailTab === "plan" ? "active" : ""} aria-pressed={detailTab === "plan"} onClick={() => setDetailTab("plan")}>执行计划 <span>{selectedPlan.length}</span></button>
              <button type="button" className={detailTab === "runs" ? "active" : ""} aria-pressed={detailTab === "runs"} onClick={() => setDetailTab("runs")}>运行记录 <span>{selectedRuns.length}</span></button>
            </nav>
            <div className="work-item-detail-body">
              {detailTab === "overview" ? <>
                <section className="work-item-detail-section"><div className="work-item-section-heading"><h3>目标</h3></div><p className="work-item-description">{selected.description || "该工作项尚未补充目标描述。"}</p></section>
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

              {detailTab === "runs" ? <section className="work-item-detail-section">
                <div className="work-item-section-heading"><h3>运行记录</h3><small>每次运行使用独立任务空间</small></div>
                {selectedRuns.length ? selectedRuns.map(run => <div className="work-item-run-card" key={run.id}><span className={`work-item-run-status ${run.status}`}><History size={14} /></span><div><b>{run.id}</b><small>{run.workflow ?? "默认工作流"} · {run.startedAt}</small><code>{run.workspacePath ?? workspacePath(selected)}</code></div><em>{runStatusLabels[run.status]}</em></div>) : <WorkItemEmptySection>暂无运行记录。</WorkItemEmptySection>}
              </section> : null}
            </div>
            <footer className="work-item-detail-footer">
              <div><small>运行不会使用当前打开目录</small><code>{workspacePath(selected)}</code>{runNotice ? <span>{runNotice}</span> : null}</div>
              <button type="button" className="work-item-primary-action" disabled={!selected.executionEligible} onClick={openRunSetup}><Play size={14} />开始执行</button>
            </footer>
          </aside>
        </div>
      ) : null}

      {selected && runSetupOpen ? (
        <div className="work-item-run-modal-layer" onMouseDown={event => { if (event.target === event.currentTarget) closeRunSetup(); }}>
          <section className="work-item-run-modal" role="dialog" aria-modal="true" aria-label="开始执行工作项">
            <header><div><h2>开始执行工作项</h2><p>确认执行资源和隔离任务空间。</p></div><button type="button" aria-label="关闭执行配置" onClick={closeRunSetup}><X size={16} /></button></header>
            <div className="work-item-run-modal-body">
              <div className="work-item-run-field"><span>执行工作流</span><b><ListChecks size={14} />标准研发流程</b></div>
              <div className="work-item-run-field"><span>执行环境</span><b><Bot size={14} />本地隔离环境</b></div>
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
            <footer><button type="button" className="work-item-secondary-action" disabled={startingRun} onClick={closeRunSetup}>取消</button><button type="button" className="work-item-primary-action" disabled={!canStartRun} onClick={() => void startRun()}><Play size={14} />{startingRun ? "正在创建…" : "创建运行"}</button></footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
