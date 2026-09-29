import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Bot, CircleAlert, Eye, GitMerge, Hand, Plus, RotateCcw, Search, Square, X } from "lucide-react";
import type {
  BacklogCreateInput,
  BacklogExecutionMode,
  BacklogItem,
  BacklogListOptions,
  BacklogPlatform,
  BacklogRunSummary,
  BacklogRuntimeSummary,
} from "../../../shared/backlog-contract";
import type { WorkflowTemplateSummary } from "../../../shared/ipc-contract";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SelectMenu } from "../../components/SelectMenu";
import { BacklogDetailDrawer } from "./BacklogDetailDrawer";
import { fetchBacklogList, invalidateBacklogCache, readBacklogCache, resetBacklogCache } from "./backlog-cache";
import { BACKLOG_STATE_LABELS, backlogStateLabel, filterBacklogItems, type SourceFilter } from "./backlog-filter";
import "./backlog.css";

export { backlogStateLabel, filterBacklogItems, BACKLOG_STATE_LABELS } from "./backlog-filter";
export type { SourceFilter } from "./backlog-filter";

export type BacklogPrimaryAction = "start" | "view-run" | "stop" | "recover" | "retry" | "confirm-merge" | "view-result" | "view";

type BacklogPageProps = {
  workspace: string;
  refreshVersion?: number;
  templates?: WorkflowTemplateSummary[];
  defaultTemplate?: string;
  defaultAgent?: string;
  onOpenWorkItem?: (workItemId: string) => void;
};

const sourceOptions: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  ...Object.entries(BACKLOG_STATE_LABELS).map(([value, label]) => ({ value: value as SourceFilter, label })),
];

const platformOptions: Array<{ value: "auto" | BacklogPlatform; label: string; icon?: "github" | "gitlab"; triggerLabel?: string }> = [
  { value: "auto", label: "自动探测" },
  { value: "github", label: "GitHub", icon: "github", triggerLabel: "" },
  { value: "gitlab", label: "GitLab", icon: "gitlab", triggerLabel: "" },
];

const executionModeOptions: Array<{ value: BacklogExecutionMode; label: string }> = [
  { value: "afk", label: "AFK 自动" },
  { value: "hitl", label: "HITL 人工" },
];

const EMPTY_CREATE_FORM: BacklogCreateInput = { title: "", description: "", executionMode: "afk", tags: [] };
const BACKLOG_FORCE_REFRESH = 24 * 60 * 60 * 1000;
const modalFocusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

export function getBacklogPrimaryAction(item: BacklogItem, summary?: BacklogRuntimeSummary): BacklogPrimaryAction {
  if (summary?.runtime?.status === "stale") return "recover";
  const localRunning = summary?.activeRun?.status === "starting" || summary?.activeRun?.status === "running";
  const localAlive = localRunning && summary?.activeRun?.pid !== undefined;
  if ((item.state === "in_progress" || item.state === "verification") && localAlive) return "stop";
  if (localRunning || summary?.runtime?.status === "running") return "view-run";
  if ((item.state === "ready" || item.state === "rework") && item.executionMode === "afk") return "start";
  if (item.state === "blocked" && item.executionMode === "hitl") return "retry";
  if (!item.parentId && item.state === "merge_ready" && item.executionMode === "hitl") return "confirm-merge";
  if (item.state === "done") return "view-result";
  return "view";
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(modalFocusableSelector)).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

export function BacklogPage({ workspace, refreshVersion = 0, defaultAgent = "—", onOpenWorkItem }: BacklogPageProps) {
  const cached = useMemo(() => readBacklogCache(workspace), []);
  const [items, setItems] = useState<BacklogItem[]>(cached?.items ?? []);
  const [state, setState] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<"auto" | BacklogPlatform>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const handledRefreshVersionRef = useRef(refreshVersion);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<BacklogCreateInput>(EMPTY_CREATE_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [detailSummary, setDetailSummary] = useState<BacklogRuntimeSummary | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [runBusyFor, setRunBusyFor] = useState("");
  const [runs, setRuns] = useState<Record<string, BacklogRunSummary>>({});
  const [summaries, setSummaries] = useState<Record<string, BacklogRuntimeSummary>>({});
  const createModalRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    loadGenerationRef.current += 1;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  const load = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    const generation = ++loadGenerationRef.current;
    const isCurrentRequest = () => mountedRef.current && loadGenerationRef.current === generation;
    if (!workspace.trim()) {
      if (isCurrentRequest()) {
        setItems([]);
        setRuns({});
        setSummaries({});
        setError("");
        setBusy(false);
      }
      return;
    }
    if (isCurrentRequest()) { setBusy(true); setError(""); }
    try {
      const options: BacklogListOptions | undefined = platform === "auto" ? undefined : { platform };
      const [data, persistedRuns] = await Promise.all([
        fetchBacklogList(workspace, () => window.afkDesktop.backlog.list(workspace, options ? { ...options } : undefined), force ? { now: Date.now() + BACKLOG_FORCE_REFRESH } : {}),
        window.afkDesktop.backlog.runs(workspace),
      ]);
      if (!isCurrentRequest()) return;
      const runMap = Object.fromEntries(persistedRuns.map((run) => [run.backlogId, run]));
      const runtimeEntries = await Promise.all(data
        .filter((item) => item.state === "in_progress" || item.state === "verification" || item.state === "merge_ready")
        .map(async (item) => {
          try {
            const summary = await window.afkDesktop.backlog.summary(workspace, item.id);
            return summary ? [item.id, summary] as const : null;
          } catch {
            return null;
          }
        }));
      if (!isCurrentRequest()) return;
      const baseEntries = data.map((item) => [item.id, { backlogId: item.id, backlog: item, ...(runMap[item.id] ? { activeRun: runMap[item.id] } : {}) }] as const);
      const fetchedEntries = runtimeEntries.filter((entry): entry is readonly [string, BacklogRuntimeSummary] => Boolean(entry)).map(([id, summary]) => [id, { ...summary, ...(summary.activeRun ? {} : runMap[id] ? { activeRun: runMap[id] } : {}) }] as const);
      setItems(data);
      setRuns(runMap);
      setSummaries(Object.fromEntries([...baseEntries, ...fetchedEntries]));
    } catch (cause) {
      if (isCurrentRequest()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  }, [platform, workspace]);

  useEffect(() => {
    const force = handledRefreshVersionRef.current !== refreshVersion;
    handledRefreshVersionRef.current = refreshVersion;
    if (force) invalidateBacklogCache();
    void load({ force });
  }, [load, refreshVersion]);

  useEffect(() => () => { resetBacklogCache(); }, []);

  const closeCreateModal = useCallback(() => { if (!createBusy) setCreateOpen(false); }, [createBusy]);

  useEffect(() => {
    if (!createOpen) return;
    const modal = createModalRef.current;
    if (!modal) return;
    getFocusableElements(modal)[0]?.focus();
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeCreateModal(); } };
    document.addEventListener("keydown", handleKey, true);
    return () => { document.removeEventListener("keydown", handleKey, true); };
  }, [createOpen, closeCreateModal]);

  const submitCreate = useCallback(async () => {
    setCreateBusy(true);
    setError("");
    try {
      const title = createForm.title.trim();
      const description = createForm.description.trim();
      if (!title || !description) { setError("标题与描述均为必填项"); return; }
      await window.afkDesktop.backlog.create(workspace, { title, description, tags: createForm.tags ?? [], executionMode: createForm.executionMode ?? "afk", ...(platform !== "auto" ? { platform } : {}) });
      if (!mountedRef.current) return;
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE_FORM);
      invalidateBacklogCache();
      await load({ force: true });
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setCreateBusy(false);
    }
  }, [createForm, load, platform, workspace]);

  const openDetails = useCallback(async (item: BacklogItem) => {
    setDetailSummary(summaries[item.id] ?? { backlogId: item.id, backlog: item, ...(runs[item.id] ? { activeRun: runs[item.id] } : {}) });
    setDetailBusy(true);
    setDetailError("");
    try {
      const summary = await window.afkDesktop.backlog.summary(workspace, item.id);
      if (mountedRef.current) { setDetailSummary(summary); setSummaries((current) => ({ ...current, [item.id]: summary })); }
    } catch (cause) {
      if (mountedRef.current) setDetailError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setDetailBusy(false);
    }
  }, [runs, summaries, workspace]);

  const closeDetails = useCallback(() => { if (!detailBusy) { setDetailSummary(null); setDetailError(""); } }, [detailBusy]);
  const openExternal = useCallback(async (url: string) => {
    try { await window.afkDesktop.openExternal(url); }
    catch (cause) { if (mountedRef.current) setDetailError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);

  const runLifecycleAction = useCallback(async (item: BacklogItem, action: "stop" | "recover" | "confirm-merge") => {
    setRunBusyFor(item.id);
    setError("");
    try {
      const summary = action === "stop" ? await window.afkDesktop.backlog.stop(workspace, item.id) : action === "recover" ? await window.afkDesktop.backlog.recover(workspace, item.id) : await window.afkDesktop.backlog.confirmMerge(workspace, item.id);
      if (!mountedRef.current) return;
      setSummaries((current) => ({ ...current, [item.id]: summary }));
      setItems((current) => current.map((entry) => entry.id === item.id ? summary.backlog : entry));
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setRunBusyFor("");
    }
  }, [workspace]);

  const filtered = useMemo(() => filterBacklogItems(items, query, state).sort((a, b) => b.id.localeCompare(a.id)), [items, query, state]);
  const templateOptions = templates.map((template) => ({ value: template.id, label: template.name }));)

  return (
    <section className="control-page backlog-page" aria-label="Provider Backlog">
      <header className="control-page-heading backlog-heading">
        <div><p>任务项</p><span>读取 <ProviderIcon provider="github" size={12} /> / <ProviderIcon provider="gitlab" size={12} /> 上由 AFK 管理的工作项；本机不持有凭据，由 afk CLI 完成 Provider 调用。</span></div>
        <div className="backlog-heading-actions">
          <SelectMenu label="选择 Provider" value={platform} options={platformOptions} onChange={(value) => { invalidateBacklogCache(); setPlatform(value); }} disabled={busy} />
          <button className="icon-button" onClick={() => setCreateOpen(true)} disabled={busy || !workspace.trim()} aria-label="新建 Backlog"><Plus size={16} /></button>
        </div>
      </header>
      {error ? <div className="backlog-alert error" role="alert"><CircleAlert size={15} />{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div> : null}
      <section className="backlog-toolbar">
        <label className="backlog-search"><Search size={15} /><input aria-label="搜索 Backlog" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、ID 或标签" /></label>
        <SelectMenu label="筛选状态" value={state} options={sourceOptions} onChange={setState} disabled={busy} />
      </section>
      <section className="backlog-list">
        {filtered.length ? filtered.map((item) => {
          const summary = summaries[item.id] ?? { backlogId: item.id, backlog: item, ...(runs[item.id] ? { activeRun: runs[item.id] } : {}) };
          const action = getBacklogPrimaryAction(item, summary);
          const canExecuteInWorkItem = action === "start" || action === "retry";
          const missingWorkItemId = canExecuteInWorkItem && !item.workItemId;
          const actionLabel = runBusyFor === item.id ? "处理中" : canExecuteInWorkItem ? "在工作项中执行" : action === "stop" ? "停止并转人工" : action === "recover" ? "标记阻塞并恢复" : action === "confirm-merge" ? "确认合并" : action === "view-run" ? "查看运行" : action === "view-result" ? "查看结果" : "查看详情";
          const actionTitle = missingWorkItemId ? "缺少规范化 workItemId，无法在工作项中执行" : canExecuteInWorkItem && !onOpenWorkItem ? "工作项导航未配置" : actionLabel;
          return (
            <article className={`backlog-row${detailSummary?.backlogId === item.id ? " selected" : ""}`} key={item.id} onClick={() => { void openDetails(item); }}>
              <span className={`backlog-mode-mark is-${item.executionMode}`} aria-label={item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"} title={item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}>{item.executionMode === "afk" ? <Bot size={16} aria-hidden="true" /> : <Hand size={16} aria-hidden="true" />}</span>
              <div className="backlog-row-body">
                <header><div className="backlog-row-heading"><b>{item.title}</b><small>#{item.id}</small></div><button type="button" className="backlog-run-button" onClick={(event) => { event.stopPropagation(); if (canExecuteInWorkItem) { if (item.workItemId) onOpenWorkItem?.(item.workItemId); } else if (action === "stop" || action === "recover" || action === "confirm-merge") { void runLifecycleAction(item, action); } else { void openDetails(item); } }} disabled={runBusyFor === item.id || (canExecuteInWorkItem && (!item.workItemId || !onOpenWorkItem))} aria-label={actionLabel} title={actionTitle}>{canExecuteInWorkItem ? <ArrowUpRight size={12} aria-hidden="true" /> : action === "stop" ? <Square size={11} fill="currentColor" aria-hidden="true" /> : action === "recover" ? <RotateCcw size={12} aria-hidden="true" /> : action === "confirm-merge" ? <GitMerge size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}<span className="backlog-run-button-label">{actionLabel}</span></button></header>
                <div className="backlog-item-metadata"><span className={`backlog-state-label backlog-state-${item.state}`}><i aria-hidden="true" />{backlogStateLabel(item.state)}</span></div>
                {missingWorkItemId ? <p className="backlog-run-status">缺少规范化 workItemId，请先关联工作项</p> : null}
                {runs[item.id] ? <p className="backlog-run-status">运行状态：{runs[item.id].status === "running" ? "运行中" : runs[item.id].status === "completed" ? "进程已退出，QA 未确认" : runs[item.id].status === "starting" ? "启动中" : "失败"} · PID {runs[item.id].pid ?? "—"}</p> : null}
                {item.tags.length ? <ul className="backlog-tags">{item.tags.map((tag) => <li key={tag}><span>{tag}</span></li>)}</ul> : null}
              </div>
            </article>
          );
        }) : <div className="backlog-empty"><b>{busy ? "正在读取 Backlog…" : workspace.trim() ? "没有匹配的工作项" : "请先选择工作区"}</b><span>{workspace.trim() ? "Provider Backlog 由 afk CLI 通过 gh / glab 调用；请先安装 CLI 并完成鉴权。" : "项目 Backlog 依赖本地工作区；全局工作项不受此限制。"}</span></div>}
      </section>
      <BacklogDetailDrawer summary={detailSummary} busy={detailBusy} error={detailError} defaultAgent={defaultAgent} onClose={closeDetails} onOpenExternal={(url) => { void openExternal(url); }} />
      {createOpen ? (
        <div className="backlog-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeCreateModal(); }}>
          <form ref={createModalRef} className="backlog-modal" role="dialog" aria-modal="true" aria-labelledby="backlog-create-title" onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const focusableElements = getFocusableElements(event.currentTarget);
            if (!focusableElements.length) return;
            const firstFocusable = focusableElements[0];
            const lastFocusable = focusableElements[focusableElements.length - 1];
            if (event.shiftKey && document.activeElement === firstFocusable) { event.preventDefault(); lastFocusable.focus(); }
            else if (!event.shiftKey && document.activeElement === lastFocusable) { event.preventDefault(); firstFocusable.focus(); }
          }} onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
            <header><h2 id="backlog-create-title">新建 Backlog</h2><button type="button" className="icon-button" onClick={closeCreateModal} aria-label="关闭"><X size={16} /></button></header>
            <label className="backlog-modal-field">标题<input required value={createForm.title} onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))} placeholder="登录态切换" /></label>
            <label className="backlog-modal-field">描述<textarea required rows={4} value={createForm.description} onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))} placeholder="描述这个 backlog 的目标、验收标准与依赖" /></label>
            <div className="backlog-modal-row"><div className="backlog-modal-field"><span>执行模式</span><SelectMenu label="执行模式" value={createForm.executionMode ?? "afk"} options={executionModeOptions} onChange={(value) => setCreateForm((current) => ({ ...current, executionMode: value }))} /></div><label className="backlog-modal-field">Platform{platform === "auto" ? <small>（继承顶部选择器，自动探测）</small> : <small>（继承 {platform}）</small>}</label></div>
            <label className="backlog-modal-field">标签（用逗号分隔）<input value={(createForm.tags ?? []).join(", ")} onChange={(event) => setCreateForm((current) => ({ ...current, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) }))} placeholder="billing, urgent" /></label>
            <footer><button type="button" onClick={closeCreateModal} disabled={createBusy}>取消</button><button type="submit" disabled={createBusy}>{createBusy ? "创建中…" : "创建"}</button></footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
