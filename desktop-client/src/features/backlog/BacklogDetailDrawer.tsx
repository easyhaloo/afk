import { Bot, ExternalLink, GitBranch, Hand, Hash, LoaderCircle, Tags, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { BacklogRuntimeSummary } from "../../../shared/backlog-contract";
import { backlogStateLabel } from "./backlog-filter";
import { MarkdownContent } from "./MarkdownContent";

type BacklogDetailDrawerProps = {
  summary: BacklogRuntimeSummary | null;
  busy: boolean;
  error: string;
  defaultAgent: string;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
};

function DetailValue({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return <div className="backlog-detail-value"><span className="backlog-detail-label">{icon}{label}</span><strong>{value}</strong></div>;
}

function runtimeStatusLabel(status?: BacklogRuntimeSummary["runtime"] extends infer Runtime ? Runtime extends { status: infer Status } ? Status : never : never) {
  return status === "running" ? "运行中" : status === "stale" ? "运行失联" : status === "completed" ? "已完成" : status === "blocked" ? "已阻塞" : status === "failed" ? "失败" : "未运行";
}

function processStatusLabel(status?: BacklogRuntimeSummary["activeRun"] extends infer Run ? Run extends { status: infer Status } ? Status : never : never) {
  return status === "starting" ? "启动中" : status === "running" ? "运行中" : status === "completed" ? "已退出（成功）" : status === "failed" ? "已退出（失败）" : "无本地进程";
}

export function BacklogDetailDrawer({ summary, busy, error, defaultAgent, onClose, onOpenExternal }: BacklogDetailDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const item = summary?.backlog ?? null;

  useEffect(() => {
    if (!item || typeof document === "undefined") return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [item, onClose]);

  if (!item) return null;
  const runtime = summary?.runtime;
  const process = summary?.activeRun;

  return (
    <div className="backlog-drawer-layer" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="backlog-drawer" role="dialog" aria-modal="true" aria-labelledby="backlog-detail-title">
        <header className="backlog-drawer-header">
          <div>
            <span className="backlog-eyebrow">BACKLOG DETAIL</span>
            <h2 id="backlog-detail-title">{item.title}</h2>
            <div className="backlog-detail-summary">
              <small>#{item.id}</small><span aria-hidden="true">·</span>
              <span className={`backlog-status-pill ${item.state}`}>{backlogStateLabel(item.state)}</span>
              <span className={`backlog-mode-tag is-${item.executionMode}`}>{item.executionMode === "afk" ? <Bot size={14} aria-hidden="true" /> : <Hand size={14} aria-hidden="true" />}{item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}</span>
            </div>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="关闭详情"><X size={17} /></button>
        </header>
        {busy ? <div className="backlog-detail-loading"><LoaderCircle size={18} className="spin" />正在读取详情…</div> : null}
        {error ? <div className="backlog-detail-error" role="alert">{error}</div> : null}
        {!busy && !error ? (
          <div className="backlog-detail-content">
            <section className="backlog-detail-section">
              <span className="backlog-detail-section-title">描述</span>
              <div className="backlog-detail-description"><MarkdownContent source={item.description || "暂无描述"} /></div>
            </section>

            <section className="backlog-detail-group" aria-label="Provider 状态">
              <header><span className="backlog-detail-section-title">Provider 状态</span><strong>{backlogStateLabel(item.state)}</strong></header>
              <div className="backlog-detail-grid">
                <DetailValue icon={<Hash size={13} />} label="状态" value={backlogStateLabel(item.state)} />
                <DetailValue icon={item.executionMode === "afk" ? <Bot size={13} /> : <Hand size={13} />} label="模式" value={item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"} />
                <DetailValue icon={<Hash size={13} />} label="依赖" value={item.dependsOn.length ? item.dependsOn.map((id) => `#${id}`).join("、") : "无"} />
                <DetailValue icon={<GitBranch size={13} />} label="变更请求" value={item.state === "merge_ready" || item.state === "done" ? "已关联 · 由 AFK 核心管理" : "未关联"} />
                <DetailValue icon={<Hash size={13} />} label="Provider 引用" value={item.providerRef || "—"} />
                <DetailValue icon={<GitBranch size={13} />} label="分支" value={item.branchName || "—"} />
                {item.parentId ? <DetailValue icon={<Hash size={13} />} label="父工作项" value={`#${item.parentId}`} /> : null}
                {item.baseBacklogId ? <DetailValue icon={<GitBranch size={13} />} label="执行基线" value={`#${item.baseBacklogId}`} /> : null}
                {item.tags.length ? <DetailValue icon={<Tags size={13} />} label="标签" value={item.tags.join("、")} /> : null}
              </div>
            </section>

            <section className="backlog-detail-group" aria-label="执行状态">
              <header><span className="backlog-detail-section-title">执行状态</span><strong>{runtimeStatusLabel(runtime?.status)}</strong></header>
              <div className="backlog-detail-grid" aria-label="运行诊断">
                <DetailValue icon={<Hash size={13} />} label="阶段" value={runtime?.phase === "verifying" ? "验证" : runtime?.phase === "implementing" ? "实现" : "—"} />
                <DetailValue icon={<Hash size={13} />} label="进度" value={runtime?.progress || "—"} />
                <DetailValue icon={<Hash size={13} />} label="心跳" value={runtime?.heartbeatAt || "—"} />
                <DetailValue icon={<Bot size={13} />} label="Agent" value={defaultAgent} />
                <DetailValue icon={<GitBranch size={13} />} label="运行分支" value={runtime?.branch || "—"} />
                <DetailValue icon={<Hash size={13} />} label="Worktree" value={runtime?.worktree || "—"} />
              </div>
            </section>

            <section className="backlog-detail-group" aria-label="本地进程">
              <header><span className="backlog-detail-section-title">本地进程</span><strong>{processStatusLabel(process?.status)}</strong></header>
              <div className="backlog-detail-grid" aria-label="启动进程">
                <DetailValue icon={<Hash size={13} />} label="PID" value={process?.pid ?? "—"} />
                <DetailValue icon={<Hash size={13} />} label="启动时间" value={process?.startedAt || "—"} />
                <DetailValue icon={<Hash size={13} />} label="退出状态" value={processStatusLabel(process?.status)} />
                <DetailValue icon={<Hash size={13} />} label="模板" value={process?.template || "工作区默认"} />
                {process?.error ? <DetailValue icon={<Hash size={13} />} label="启动错误" value={process.error} /> : null}
              </div>
            </section>

            {item.webUrl ? <button type="button" className="backlog-external-link" aria-label="在浏览器中打开" onClick={() => onOpenExternal(item.webUrl!)}><ExternalLink size={15} />在浏览器中打开<span aria-hidden="true">↗</span></button> : <p className="backlog-detail-muted">该工作项没有可用的外部链接。</p>}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
