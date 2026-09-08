import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Play, Plus, RefreshCw, Search, X } from "lucide-react";
import type {
  BacklogCreateInput,
  BacklogExecutionMode,
  BacklogItem,
  BacklogListOptions,
  BacklogPlatform,
  BacklogRunSummary,
  BacklogState,
} from "../../../shared/backlog-contract";
import {
  fetchBacklogList,
  invalidateBacklogCache,
  readBacklogCache,
  resetBacklogCache,
} from "./backlog-cache";
import {
  BACKLOG_STATE_LABELS,
  backlogStateLabel,
  filterBacklogItems,
  type SourceFilter,
} from "./backlog-filter";
import "./backlog.css";

export { backlogStateLabel, filterBacklogItems, BACKLOG_STATE_LABELS } from "./backlog-filter";
export type { SourceFilter } from "./backlog-filter";

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

const modalFocusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(modalFocusableSelector)).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

const EMPTY_CREATE_FORM: BacklogCreateInput = { title: "", description: "", executionMode: "afk", tags: [] };

type BacklogPageProps = { workspace: string };

export function BacklogPage({ workspace }: BacklogPageProps) {
  const cached = useMemo(() => readBacklogCache(workspace), []);
  const [items, setItems] = useState<BacklogItem[]>(cached?.items ?? []);
  const [state, setState] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<"auto" | BacklogPlatform>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<BacklogCreateInput>(EMPTY_CREATE_FORM);
  const [createBusy, setCreateBusy] = useState(false);

  const [tagBusyFor, setTagBusyFor] = useState("");
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [runBusyFor, setRunBusyFor] = useState("");
  const [runs, setRuns] = useState<Record<string, BacklogRunSummary>>({});

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
    if (isCurrentRequest()) {
      setBusy(true);
      setError("");
    }
    try {
      const options: BacklogListOptions | undefined = platform === "auto" ? undefined : { platform };
      const [data, persistedRuns] = await Promise.all([
        fetchBacklogList(workspace, () => {
          const opts = options ? { ...options } : undefined;
          return window.afkDesktop.backlog.list(workspace, opts);
        }, force ? { now: Date.now() + BACKLOG_FORCE_REFRESH } : {}),
        window.afkDesktop.backlog.runs(workspace),
      ]);
      if (!isCurrentRequest()) return;
      setItems(data);
      setRuns(Object.fromEntries(persistedRuns.map((run) => [run.backlogId, run])));
    } catch (cause) {
      if (isCurrentRequest()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  }, [platform, workspace]);

  useEffect(() => {
    void load();
  }, [load, workspace]);

  useEffect(() => () => { resetBacklogCache(); }, []);

  const closeCreateModal = useCallback(() => {
    if (createBusy) return;
    setCreateOpen(false);
  }, [createBusy]);

  useEffect(() => {
    if (!createOpen) return;
    const modal = createModalRef.current;
    if (!modal) return;
    getFocusableElements(modal)[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeCreateModal(); }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => { document.removeEventListener("keydown", handleKey, true); };
  }, [createOpen, closeCreateModal]);

  const submitCreate = useCallback(async () => {
    setCreateBusy(true);
    setError("");
    try {
      const title = createForm.title.trim();
      const description = createForm.description.trim();
      if (!title || !description) {
        setError("标题与描述均为必填项");
        return;
      }
      const input: BacklogCreateInput = {
        title,
        description,
        tags: createForm.tags ?? [],
        executionMode: createForm.executionMode ?? "afk",
        ...(platform !== "auto" ? { platform } : {}),
      };
      await window.afkDesktop.backlog.create(workspace, input);
      if (!mountedRef.current) return;
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE_FORM);
      invalidateBacklogCache();
      await load({ force: true });
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setCreateBusy(false);
    }
  }, [createForm, load, platform, workspace]);

  const addTag = useCallback(async (itemId: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setTagBusyFor(itemId);
    setError("");
    try {
      await window.afkDesktop.backlog.addTag(workspace, itemId, trimmed);
      if (!mountedRef.current) return;
      setTagDrafts((prev) => ({ ...prev, [itemId]: "" }));
      invalidateBacklogCache();
      await load({ force: true });
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setTagBusyFor("");
    }
  }, [load, workspace]);

  const removeTag = useCallback(async (itemId: string, tag: string) => {
    setTagBusyFor(itemId);
    setError("");
    try {
      await window.afkDesktop.backlog.removeTag(workspace, itemId, tag);
      if (!mountedRef.current) return;
      invalidateBacklogCache();
      await load({ force: true });
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setTagBusyFor("");
    }
  }, [load, workspace]);

  const startRun = useCallback(async (item: BacklogItem) => {
    setRunBusyFor(item.id);
    setError("");
    try {
      const run = await window.afkDesktop.backlog.start(workspace, { backlogId: item.id });
      if (!mountedRef.current) return;
      setRuns((previous) => ({ ...previous, [item.id]: run }));
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setRunBusyFor("");
    }
  }, [workspace]);

  const filtered = useMemo(() => filterBacklogItems(items, query, state), [items, query, state]);

  return (
    <section className="control-page backlog-page" aria-label="Provider Backlog">
      <header className="control-page-heading backlog-heading">
        <div>
          <p>任务项</p>
          <h1>Provider Backlog</h1>
          <span>读取 GitHub / GitLab 上由 AFK 管理的工作项；本机不持有凭据，由 afk CLI 完成 Provider 调用。</span>
        </div>
        <div className="backlog-heading-actions">
          <select aria-label="选择 Provider" value={platform} onChange={(event) => { invalidateBacklogCache(); setPlatform(event.currentTarget.value as "auto" | BacklogPlatform); }} disabled={busy}>
            {platformOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button className="icon-button" onClick={() => setCreateOpen(true)} disabled={busy} aria-label="新建 Backlog">
            <Plus size={16} />
          </button>
          <button className="icon-button" onClick={() => { invalidateBacklogCache(); void load({ force: true }); }} disabled={busy} aria-label="刷新 Backlog">
            <RefreshCw size={16} className={busy ? "spin" : ""} />
          </button>
        </div>
      </header>
      {error ? <div className="backlog-alert error" role="alert"><CircleAlert size={15} />{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div> : null}
      <section className="backlog-toolbar">
        <label className="backlog-search"><Search size={15} /><input aria-label="搜索 Backlog" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、ID 或标签" /></label>
        <select aria-label="筛选状态" value={state} onChange={(event) => setState(event.currentTarget.value as SourceFilter)} disabled={busy}>
          {sourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </section>
      <section className="backlog-list">
        {filtered.length ? filtered.map((item) => (
          <article className="backlog-row" key={item.id}>
            <header>
              <b>{item.title}</b>
              <small>#{item.id}</small>
            </header>
            <p>{backlogStateLabel(item.state)} · {item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}</p>
            {runs[item.id] ? <p className="backlog-run-status">运行状态：{runs[item.id].status === "running" ? "运行中" : runs[item.id].status === "completed" ? "已完成" : "失败"} · PID {runs[item.id].pid ?? "—"}</p> : null}
            {item.tags.length ? (
              <ul className="backlog-tags">
                {item.tags.map((tag) => (
                  <li key={tag}>
                    <span>{tag}</span>
                    <button type="button" className="backlog-tag-remove" aria-label={`移除标签 ${tag}`} disabled={tagBusyFor === item.id} onClick={() => { void removeTag(item.id, tag); }}>×</button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form className="backlog-tag-add" onSubmit={(event) => { event.preventDefault(); void addTag(item.id, tagDrafts[item.id] ?? ""); }}>
              <input
                value={tagDrafts[item.id] ?? ""}
                onChange={(event) => setTagDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))}
                aria-label={`为 ${item.title} 添加标签`}
                placeholder={tagBusyFor === item.id ? "提交中…" : "+ 标签"}
                disabled={tagBusyFor === item.id}
              />
            </form>
            <footer className="backlog-row-actions">
              <button type="button" className="backlog-run-button" onClick={() => { void startRun(item); }} disabled={runBusyFor === item.id || item.state !== "ready" || runs[item.id]?.status === "running"}>
                <Play size={13} />
                {runBusyFor === item.id ? "启动中…" : runs[item.id]?.status === "running" ? "运行中" : runs[item.id]?.status === "failed" ? "重新执行" : "开始执行"}
              </button>
            </footer>
          </article>
        )) : (
          <div className="backlog-empty">
            <b>{busy ? "正在读取 Backlog…" : "没有匹配的工作项"}</b>
            <span>Provider Backlog 由 afk CLI 通过 gh / glab 调用；请先安装 CLI 并完成鉴权。</span>
          </div>
        )}
      </section>
      {createOpen ? (
        <div className="backlog-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeCreateModal(); }}>
          <form
            ref={createModalRef}
            className="backlog-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backlog-create-title"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusableElements = getFocusableElements(event.currentTarget);
              if (!focusableElements.length) return;
              const firstFocusable = focusableElements[0];
              const lastFocusable = focusableElements[focusableElements.length - 1];
              if (event.shiftKey && document.activeElement === firstFocusable) { event.preventDefault(); lastFocusable.focus(); }
              else if (!event.shiftKey && document.activeElement === lastFocusable) { event.preventDefault(); firstFocusable.focus(); }
            }}
            onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}
          >
            <header>
              <h2 id="backlog-create-title">新建 Backlog</h2>
              <button type="button" className="icon-button" onClick={closeCreateModal} aria-label="关闭"><X size={16} /></button>
            </header>
            <label className="backlog-modal-field">标题<input required value={createForm.title} onChange={(event) => setCreateForm((prev) => ({ ...prev, title: event.target.value }))} placeholder="登录态切换" /></label>
            <label className="backlog-modal-field">描述<textarea required rows={4} value={createForm.description} onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))} placeholder="描述这个 backlog 的目标、验收标准与依赖" /></label>
            <div className="backlog-modal-row">
              <label className="backlog-modal-field">执行模式<select value={createForm.executionMode ?? "afk"} onChange={(event) => setCreateForm((prev) => ({ ...prev, executionMode: event.currentTarget.value as BacklogExecutionMode }))}>
                {executionModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select></label>
              <label className="backlog-modal-field">Platform{platform === "auto" ? <small>（继承顶部选择器，自动探测）</small> : <small>（继承 {platform}）</small>}</label>
            </div>
            <label className="backlog-modal-field">标签（用逗号分隔）<input value={(createForm.tags ?? []).join(", ")} onChange={(event) => setCreateForm((prev) => ({ ...prev, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) }))} placeholder="billing, urgent" /></label>
            <footer>
              <button type="button" onClick={closeCreateModal} disabled={createBusy}>取消</button>
              <button type="submit" disabled={createBusy}>{createBusy ? "创建中…" : "创建"}</button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}

// Force-refresh marker: a timestamp in the future bypasses cache freshness.
const BACKLOG_FORCE_REFRESH = 24 * 60 * 60 * 1000;
