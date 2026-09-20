import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ExternalLink, GitBranch, RefreshCw, Search, ShieldAlert, X } from "lucide-react";
import type { BacklogPlatform, GlobalWorkItem, WorkItemInventoryDiagnostic, WorkItemInventoryResult } from "../../../shared/backlog-contract";
import { SelectMenu } from "../../components/SelectMenu";
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

function diagnosticTitle(diagnostic: WorkItemInventoryDiagnostic): string {
  return diagnostic.projectKey ? `${diagnostic.platform} · ${diagnostic.projectKey}` : diagnostic.platform;
}

export function WorkItemsPage() {
  const [inventory, setInventory] = useState<WorkItemInventoryResult>(emptyInventory);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<"all" | BacklogPlatform>("all");
  const [project, setProject] = useState("all");
  const [selected, setSelected] = useState<GlobalWorkItem | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(pageSize);
  const requestVersion = useRef(0);

  const load = async (forceRefresh = false) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const next = await window.afkDesktop.workItems.list(platform === "all" ? undefined : { platform }, ...(forceRefresh ? [true] : []));
      if (version === requestVersion.current) setInventory(next);
    } catch (cause) {
      if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { requestVersion.current += 1; };
  }, [platform]);

  const projectOptions = useMemo(() => [
    { value: "all", label: "全部仓库" },
    ...inventory.projects
      .filter(item => platform === "all" || item.platform === platform)
      .map(item => ({ value: `${item.platform}:${item.projectKey}`, label: item.projectKey })),
  ], [inventory.projects, platform]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inventory.items.filter(item => {
      if (platform !== "all" && item.project.platform !== platform) return false;
      if (project !== "all" && `${item.project.platform}:${item.project.projectKey}` !== project) return false;
      return !normalized || `${item.title} ${item.project.projectKey} ${item.issueNumber} ${item.tags.join(" ")}`.toLowerCase().includes(normalized);
    });
  }, [inventory.items, platform, project, query]);

  return (
    <section className="backlog-page work-items-page">
      <div className="control-page-heading backlog-heading">
        <div><p>工作项</p><span>从已授权的 GitHub / GitLab 全部仓库读取 Issue；发现过程与本地目录无关。</span></div>
        <button type="button" className="work-items-refresh" aria-label="刷新工作项" title="刷新工作项" disabled={loading} onClick={() => void load(true)}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
      </div>
      {error ? <div className="backlog-alert error"><ShieldAlert size={15} />{error}</div> : null}
      {inventory.diagnostics.length ? <div className="work-item-diagnostics">{inventory.diagnostics.map((diagnostic, index) => <div key={`${diagnostic.platform}-${diagnostic.projectKey ?? "provider"}-${index}`}><b>{diagnosticTitle(diagnostic)}</b><span>{diagnostic.message}</span></div>)}</div> : null}
      <div className="backlog-toolbar">
        <label className="backlog-search"><Search size={14} /><input aria-label="搜索工作项" value={query} onChange={event => { setQuery(event.target.value); setVisibleLimit(pageSize); }} placeholder="搜索标题、仓库、Issue 或标签" /></label>
        <SelectMenu label="选择 Provider" value={platform} options={[{ value: "all", label: "全部 Provider" }, { value: "github", label: "GitHub" }, { value: "gitlab", label: "GitLab" }]} onChange={value => { setPlatform(value as "all" | BacklogPlatform); setProject("all"); setVisibleLimit(pageSize); }} />
        <SelectMenu label="选择仓库" value={project} options={projectOptions} onChange={value => { setProject(value); setVisibleLimit(pageSize); }} />
      </div>
      <div className="backlog-list">
        {visibleItems.length ? visibleItems.slice(0, visibleLimit).map(item => (
          <article key={item.id} className="backlog-row work-item-row" onClick={() => setSelected(item)}>
            <span className={`backlog-mode-mark ${item.executionMode === "afk" ? "is-afk" : "is-hitl"}`}><Bot size={15} /></span>
            <div className="backlog-row-body">
              <header><b>{item.title}</b><small>#{item.issueNumber}</small></header>
              <p className="work-item-project"><GitBranch size={12} />{item.project.projectKey}</p>
              <div className="backlog-item-metadata"><span className={`backlog-state-label backlog-state-${item.state}`}>{stateLabels[item.state]}</span><span className={item.managed ? "work-item-managed" : "work-item-unmanaged"}>{item.managed ? item.executionEligible ? "AFK 可执行" : "AFK 已管理" : "普通 Issue"}</span>{item.tags.map(tag => <span className="backlog-tag" key={tag}>{tag}</span>)}</div>
            </div>
          </article>
        )) : <div className="backlog-empty"><b>{loading ? "正在读取全部仓库的工作项…" : "没有匹配的工作项"}</b><span>{loading ? "首次加载会分页查询已授权 Provider。" : "请检查 Provider 鉴权或调整筛选条件。"}</span></div>}
      </div>
      {visibleItems.length > visibleLimit ? <button type="button" className="work-items-load-more" aria-label="显示更多工作项" onClick={() => setVisibleLimit(limit => limit + pageSize)}>显示更多（{Math.min(visibleLimit, visibleItems.length)} / {visibleItems.length}）</button> : null}
      {selected ? <aside className="work-item-detail" role="dialog" aria-label={`工作项 ${selected.id}`}><header><div><small>{selected.project.platform}</small><b>{selected.project.projectKey} #{selected.issueNumber}</b></div><button type="button" aria-label="关闭工作项详情" onClick={() => setSelected(null)}><X size={15} /></button></header><h2>{selected.title}</h2><p>{selected.description || "该 Issue 没有描述。"}</p><dl><div><dt>全局 ID</dt><dd>{selected.id}</dd></div><div><dt>执行资格</dt><dd>{selected.executionEligible ? "可在隔离任务目录中执行" : selected.managed ? "当前状态不可执行" : "未由 AFK 管理"}</dd></div><div><dt>分支</dt><dd>{selected.branchName}</dd></div></dl>{selected.webUrl ? <button type="button" className="backlog-external-link" onClick={() => void window.afkDesktop.openExternal(selected.webUrl!)}><ExternalLink size={14} />在浏览器中打开</button> : null}</aside> : null}
    </section>
  );
}
