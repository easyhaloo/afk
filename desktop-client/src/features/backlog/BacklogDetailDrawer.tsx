import { ExternalLink, GitBranch, Hash, LoaderCircle, Tags, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { BacklogItem } from "../../../shared/backlog-contract";
import { backlogStateLabel } from "./backlog-filter";
import { MarkdownContent } from "./MarkdownContent";

type BacklogDetailDrawerProps = {
  item: BacklogItem | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
};

function DetailValue({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return <div className="backlog-detail-value"><span className="backlog-detail-label">{icon}{label}</span><strong>{value}</strong></div>;
}

export function BacklogDetailDrawer({ item, busy, error, onClose, onOpenExternal }: BacklogDetailDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
              <span className={`backlog-status-pill ${item.state}`}>{backlogStateLabel(item.state)}</span>
              <span className="backlog-detail-mode">{item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}</span>
            </div>
            <section className="backlog-detail-section">
              <span className="backlog-detail-section-title">描述</span>
              <div className="backlog-detail-description">
                <MarkdownContent source={item.description || "暂无描述"} />
              </div>
            </section>
            <section className="backlog-detail-grid" aria-label="工作项元数据">
              <DetailValue icon={<Hash size={13} />} label="Provider 引用" value={item.providerRef || "—"} />
              <DetailValue icon={<GitBranch size={13} />} label="分支" value={item.branchName || "—"} />
              <DetailValue icon={<Tags size={13} />} label="标签" value={item.tags.length ? item.tags.join("、") : "无标签"} />
              <DetailValue icon={<Hash size={13} />} label="依赖" value={item.dependsOn.length ? item.dependsOn.map((id) => `#${id}`).join("、") : "无依赖"} />
            </section>
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
