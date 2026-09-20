import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleAlert, Eye, GitMerge, Hand, Play, Plus, RotateCcw, Search, Square, X } from "lucide-react";
import type {
  BacklogCreateInput,
  BacklogExecutionMode,
  BacklogItem,
  BacklogListOptions,
  BacklogPlatform,
  BacklogRunRetryInput,
  BacklogRunStartInput,
  BacklogRunSummary,
  BacklogRuntimeSummary,
} from "../../../shared/backlog-contract";
import type { WorkflowTemplateSummary } from "../../../shared/ipc-contract";
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
};

const sourceOptions: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  ...Object.entries(BACKLOG_STATE_LABELS).map(([value, label]) => ({ value: value as SourceFilter, label })),
];

const platformOptions: Array<{ value: "auto" | BacklogPlatform; label: string }> = [
  { value: "auto", label: "自动探测" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

const executionModeOptions: Array<{ value: BacklogExecutionMode; label: string }> = [
  { value: "afk", label: "AFK 自动" },
  { value: "hitl", label: "HITL 人工" },
];

const actionLabels: Record<BacklogPrimaryAction, string> = {
  start: "开始执行",
  "view-run": "查看运行",
  stop: "停止并转人工",
  recover: "标记阻塞并恢复",
  retry: "修复后重试",
  "confirm-merge": "确认合并",
  "view-result": "查看结果",
  view: "查看详情",
};

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

function templateSourceLabel(source?: WorkflowTemplateSummary["source"]): string {
  return source === "builtin" ? "AFK 内置" : source === "managed" ? "本项目 · 自定义" : source === "project" ? "本项目" : "工作区默认";
}

function templateStepLabel(step: WorkflowTemplateSummary["steps"][number]): string {
  if (step.kind === "system") return step.action || step.id;
  if (step.role === "reviewer") return "审查";
  if (step.role === "implementer") return "实现";
  return step.id;
}

function ActionIcon({ action }: { action: BacklogPrimaryAction }) {
  if (action === "start") return <Play size={12} fill="currentColor" aria-hidden="true" />;
  if (action === "stop") return <Square size={11} fill="currentColor" aria-hidden="true" />;
  if (action === "recover" || action === "retry") return <RotateCcw size={12} aria-hidden="true" />;
  if (action === "confirm-merge") return <GitMerge size={12} aria-hidden="true" />;
  return <Eye size={12} aria-hidden="true" />;
}

export function BacklogPage({ workspace, refreshVersion = 0, templates = [], defaultTemplate, defaultAgent = "—" }: BacklogPageProps) {
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
  const [launchItem, setLaunchItem] = useState<{ item: BacklogItem; intent: "start" | "retry" } | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState(defaultTemplate ?? templates[0]?.id ?? "");
  const [retryReason, setRetryReason] = useState("已完成人工修复，重新执行");
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

  const launchRun = useCallback(async () => {
    if (!launchItem) return;
    const { item, intent } = launchItem;
    setRunBusyFor(item.id);
    setError("");
    try {
      const input: BacklogRunStartInput = { backlogId: item.id, ...(selectedTemplate ? { template: selectedTemplate } : {}) };
      const run = intent === "retry"
        ? await window.afkDesktop.backlog.retry(workspace, { ...input, reason: retryReason.trim() } satisfies BacklogRunRetryInput)
        : await window.afkDesktop.backlog.start(workspace, input);
      if (!mountedRef.current) return;
      setRuns((current) => ({ ...current, [item.id]: run }));
      setSummaries((current) => ({ ...current, [item.id]: { backlogId: item.id, backlog: item, activeRun: run } }));
      setLaunchItem(null);
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setRunBusyFor("");
    }
  }, [launchItem, retryReason, selectedTemplate, workspace]);

  const runAction = useCallback(async (item: BacklogItem, action: BacklogPrimaryAction) => {
    if (action === "start" || action === "retry") {
      setSelectedTemplate(runs[item.id]?.template || defaultTemplate || templates[0]?.id || "");
      setRetryReason("已完成人工修复，重新执行");
      setLaunchItem({ item, intent: action });
      return;
    }
    if (action === "view" || action === "view-run" || action === "view-result") { await openDetails(item); return; }
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
  }, [defaultTemplate, openDetails, runs, templates, workspace]);

  const filtered = useMemo(() => filterBacklogItems(items, query, state), [items, query, state]);
  const templateOptions = templates.map((template) => ({ value: template.id, label: template.name }));

  return (
    <section className="control-page backlog-page" aria-label="Provider Backlog">
      <header className="control-page-heading backlog-heading">
        <div><p>任务项</p><span>读取 GitHub / GitLab 上由 AFK 管理的工作项；本机不持有凭据，由 afk CLI 完成 Provider 调用。</span></div>
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
          const actionLabel = runBusyFor === item.id ? "处理中" : actionLabels[action];
          const selected = templates.find((template) => template.id === selectedTemplate);
          return (
            <article className={`backlog-row${detailSummary?.backlogId === item.id ? " selected" : ""}`} key={item.id} onClick={() => { void openDetails(item); }}>
              <span className={`backlog-mode-mark is-${item.executionMode}`} aria-label={item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"} title={item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}>{item.executionMode === "afk" ? <Bot size={16} aria-hidden="true" /> : <Hand size={16} aria-hidden="true" />}</span>
              <div className="backlog-row-body">
                <header><div className="backlog-row-heading"><b>{item.title}</b><small>#{item.id}</small></div><button type="button" className="backlog-run-button" onClick={(event) => { event.stopPropagation(); void runAction(item, action); }} disabled={runBusyFor === item.id} aria-label={actionLabel} title={actionLabel}><ActionIcon action={action} /><span className="backlog-run-button-label">{actionLabel}</span></button></header>
                <div className="backlog-item-metadata"><span className={`backlog-state-label backlog-state-${item.state}`}><i aria-hidden="true" />{backlogStateLabel(item.state)}</span></div>
                {runs[item.id] ? <p className="backlog-run-status">运行状态：{runs[item.id].status === "running" ? "运行中" : runs[item.id].status === "completed" ? "已完成" : runs[item.id].status === "starting" ? "启动中" : "失败"} · PID {runs[item.id].pid ?? "—"}</p> : null}
                {item.tags.length ? <ul className="backlog-tags">{item.tags.map((tag) => <li key={tag}><span>{tag}</span></li>)}</ul> : null}
              </div>
              {launchItem?.item.id === item.id ? (
                <section className="backlog-launch-confirm" aria-label={`确认执行 Backlog ${item.id}`} onClick={(event) => event.stopPropagation()}>
                  <header><div><small>{launchItem.intent === "retry" ? "修复后重试" : "开始执行"}</small><b>#{item.id} {item.title}</b></div><button type="button" className="icon-button" aria-label="取消执行" onClick={() => setLaunchItem(null)}><X size={14} /></button></header>
                  <div className="backlog-launch-fields">
                    <div><span>执行模板</span>{templateOptions.length ? <SelectMenu label="执行模板" value={selectedTemplate} options={templateOptions} onChange={setSelectedTemplate} /> : <strong>{selectedTemplate || "工作区默认"}</strong>}</div>
                    <div><span>模板来源</span><strong>{templateSourceLabel(selected?.source)}</strong></div>
                    <div><span>执行步骤</span><strong>{selected?.steps.length ? selected.steps.map(templateStepLabel).join(" → ") : "使用模板默认步骤"}</strong></div>
                    <div><span>默认 Agent</span><strong>{defaultAgent}</strong></div>
                    {launchItem.intent === "retry" ? <label><span>修复说明</span><input value={retryReason} onChange={(event) => setRetryReason(event.target.value)} /></label> : null}
                  </div>
                  <button type="button" className="backlog-launch-button" aria-label={`启动 Backlog ${item.id}`} disabled={runBusyFor === item.id || (launchItem.intent === "retry" && !retryReason.trim())} onClick={() => { void launchRun(); }}>{runBusyFor === item.id ? "启动中…" : launchItem.intent === "retry" ? "修复后重试" : "启动"}</button>
                </section>
              ) : null}
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
