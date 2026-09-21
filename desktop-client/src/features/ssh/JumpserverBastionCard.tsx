import type { ReactElement } from "react";
import { ChevronDown } from "lucide-react";
import type { SshBastion } from "../../../shared/ssh-contract";

export type JumpserverBastionCardProps = {
  bastion: SshBastion;
  collapsed: boolean;
  selected: boolean;
  onToggleCollapse: () => void;
  onSelect: () => void;
  syncSummary?: {
    status: "healthy" | "auth-expired" | "unreachable" | "syncing" | "stale";
    linux: number;
    windows: number;
    lastSyncedAt?: string;
  };
};

type SyncStatus = NonNullable<JumpserverBastionCardProps["syncSummary"]>["status"];

const statusClass: Record<SyncStatus, string> = {
  healthy: "ssh-status.ready",
  "auth-expired": "ssh-status.untrusted",
  unreachable: "ssh-status.identity-changed",
  syncing: "ssh-status.syncing",
  stale: "ssh-status.untrusted",
};

const statusLabel: Record<SyncStatus, string> = {
  healthy: "正常",
  "auth-expired": "认证过期",
  unreachable: "不可达",
  syncing: "同步中",
  stale: "数据陈旧",
};

export function JumpserverBastionCard({ bastion, collapsed, selected, onToggleCollapse, onSelect, syncSummary }: JumpserverBastionCardProps): ReactElement {
  return (
    <div
      className={[
        "ssh-bastion-group",
        collapsed ? "collapsed" : "",
        selected ? "selected" : "",
      ].filter(Boolean).join(" ")}
      onClick={onSelect}
      role="button"
      aria-pressed={selected}
      aria-expanded={!collapsed}
    >
      <button
        type="button"
        className="ssh-bastion-chevron-btn"
        aria-label={collapsed ? "展开堡垒机" : "折叠堡垒机"}
        onClick={(event) => { event.stopPropagation(); onToggleCollapse(); }}
      >
        <ChevronDown size={16} className="ssh-bastion-chevron" aria-hidden="true" />
      </button>

      <div className="ssh-bastion-copy">
        <b>{bastion.alias}</b>
        <small>{bastion.user}@{bastion.hostname}:{bastion.port}</small>
      </div>

      <span className="ssh-bastion-type">堡垒机</span>

      {syncSummary ? (
        <span className={`ssh-status ${statusClass[syncSummary.status]}`}>
          {statusLabel[syncSummary.status]}
        </span>
      ) : (
        <span className="ssh-status">未知</span>
      )}

      {syncSummary ? (
        <span className="ssh-bastion-asset-count">
          {syncSummary.linux} Linux &middot; {syncSummary.windows} Windows
        </span>
      ) : (
        <span className="ssh-bastion-asset-count">—</span>
      )}
    </div>
  );
}
