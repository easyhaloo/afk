import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, RefreshCw, Search, X } from "lucide-react";
import type {
  BacklogItem,
  BacklogListOptions,
  BacklogPlatform,
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

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (force = false) => {
    if (mountedRef.current) { setBusy(true); setError(""); }
    try {
      const options: BacklogListOptions | undefined = platform === "auto" ? undefined : { platform };
      const data = await fetchBacklogList(workspace, () => {
        const opts = options ? { ...options } : undefined;
        return window.afkDesktop.backlog.list(workspace, opts);
      }, force ? { now: Date.now() + BACKLOG_FORCE_REFRESH } : {});
      if (mountedRef.current) setItems(data);
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [platform, workspace]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => () => { resetBacklogCache(); }, []);

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
          <select aria-label="选择 Provider" value={platform} onChange={(event) => setPlatform(event.currentTarget.value as "auto" | BacklogPlatform)} disabled={busy}>
            {platformOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button className="icon-button" onClick={() => { invalidateBacklogCache(); void load(true); }} disabled={busy} aria-label="刷新 Backlog">
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
            {item.tags.length ? <ul className="backlog-tags">{item.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul> : null}
          </article>
        )) : (
          <div className="backlog-empty">
            <b>{busy ? "正在读取 Backlog…" : "没有匹配的工作项"}</b>
            <span>Provider Backlog 由 afk CLI 通过 gh / glab 调用；请先安装 CLI 并完成鉴权。</span>
          </div>
        )}
      </section>
    </section>
  );
}

// Force-refresh marker: a timestamp in the future bypasses cache freshness.
const BACKLOG_FORCE_REFRESH = 24 * 60 * 60 * 1000;
