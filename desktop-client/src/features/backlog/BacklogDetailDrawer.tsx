import { ExternalLink, GitBranch, Hash, LoaderCircle, Tags, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { BacklogRuntimeSummary } from "../../../shared/backlog-contract";
import { backlogStateLabel } from "./backlog-filter";
import { MarkdownContent } from "./MarkdownContent";

type BacklogDetailDrawerProps = {
  summary: BacklogRuntimeSummary | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
};

function DetailValue({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return <div className="backlog-detail-value"><span className="backlog-detail-label">{icon}{label}</span><strong>{value}</strong></div>;
}

export function BacklogDetailDrawer({ summary, busy, error, onClose, onOpenExternal }: BacklogDetailDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const item = summary?.backlog ?? null;

  useEffect(() => {
    if (!item || typeof document === "undefined") return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [item, onClose]);

  if (!item) return null;
  return (
    <div className="backlog-drawer-layer" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="backlog-drawer" role="dialog" aria-modal="true" aria-labelledby="backlog-detail-title">
        <header className="backlog-drawer-header">
          <div>
            <span className="backlog-eyebrow">BACKLOG DETAIL</span>
            <h2 id="backlog-detail-title">{item.title}</h2>
            <small>#{item.id}</small>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="关闭详情"><X size={17} /></button>
        </header>
        {busy ? <div className="backlog-detail-loading"><LoaderCircle size={18} className="spin" />正在读取详情…</div> : null}
        {error ? <div className="backlog-detail-error" role="alert">{error}</div> : null}
        {!busy && !error ? (
          <div className="backlog-detail-content">
            <div className="backlog-detail-status-row">
              <span className="backlog-detail-status-prefix">Backlog</span>
              <span className={`backlog-status-pill ${item.state}`}>{backlogStateLabel(item.state)}</span>
              <span className="backlog-detail-mode">{item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}</span>
            </div>
            <section className="backlog-runtime-panel" aria-label="执行状态">
              <span className="backlog-detail-section-title">运行</span>
              {summary?.runtime ? (
                <div className="backlog-runtime-summary">
                  <strong>{summary.runtime.phase === "verifying" ? "验证执行中" : "实现执行中"}</strong>
                  <span>{summary.runtime.status === "running" ? "运行中" : summary.runtime.status === "stale" ? "运行失联" : summary.runtime.status === "completed" ? "已完成" : summary.runtime.status === "blocked" ? "已阻塞" : "失败"}</span>
                </div>
              ) : <p className="backlog-detail-muted">暂无规范化运行记录。</p>}
            </section>
            <section className="backlog-detail-section">
              <span className="backlog-detail-section-title">描述</span>
              <div className="backlog-detail-description">
                <MarkdownContent source={item.description || "暂无描述"} />
              </div>
            </section>
            <section className="backlog-detail-grid" aria-label="工作项元数据">
              <DetailValue icon={<Hash size={13} />} label="Provider 引用" value={item.providerRef || "—"} />
              <DetailValue icon={<GitBranch size={13} />} label="分支" value={item.branchName || "—"} />
              <DetailValue icon={<Hash size={13} />} label="父工作项" value={item.parentId ? `#${item.parentId}` : "—"} />
              <DetailValue icon={<GitBranch size={13} />} label="执行基线" value={item.baseBacklogId ? `#${item.baseBacklogId}` : "默认目标分支"} />
              <DetailValue icon={<Tags size={13} />} label="标签" value={item.tags.length ? item.tags.join("、") : "无标签"} />
              <DetailValue icon={<Hash size={13} />} label="依赖" value={item.dependsOn.length ? item.dependsOn.map((id) => `#${id}`).join("、") : "无依赖"} />
            </section>
            {summary?.runtime ? (
              <section className="backlog-detail-grid" aria-label="运行诊断">
                <DetailValue icon={<Hash size={13} />} label="Run ID" value={summary.runtime.runId} />
                <DetailValue icon={<Hash size={13} />} label="心跳" value={summary.runtime.heartbeatAt} />
                <DetailValue icon={<GitBranch size={13} />} label="运行分支" value={summary.runtime.branch || "—"} />
                <DetailValue icon={<Hash size={13} />} label="Worktree" value={summary.runtime.worktree || "—"} />
                <DetailValue icon={<Hash size={13} />} label="诊断目录" value={summary.runtime.diagnosticPath || "—"} />
                <DetailValue icon={<Hash size={13} />} label="进度" value={summary.runtime.progress || "—"} />
              </section>
            ) : null}
            {summary?.activeRun ? (
              <section className="backlog-detail-grid" aria-label="启动进程">
                <DetailValue icon={<Hash size={13} />} label="启动记录" value={summary.activeRun.id} />
                <DetailValue icon={<Hash size={13} />} label="进程状态" value={summary.activeRun.status} />
                <DetailValue icon={<Hash size={13} />} label="PID" value={summary.activeRun.pid ?? "—"} />
                <DetailValue icon={<Hash size={13} />} label="启动错误" value={summary.activeRun.error || "—"} />
              </section>
            ) : null}
            {item.webUrl ? (
              <button type="button" className="backlog-external-link" aria-label="在浏览器中打开" onClick={() => onOpenExternal(item.webUrl!)}>
                <ExternalLink size={15} />
                在浏览器中打开
                <span aria-hidden="true">↗</span>
              </button>
            ) : <p className="backlog-detail-muted">该工作项没有可用的外部链接。</p>}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
