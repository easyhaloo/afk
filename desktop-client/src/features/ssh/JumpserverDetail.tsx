import type { ReactElement } from "react";
import { RefreshCw, Settings, Trash2 } from "lucide-react";
import type { SshBastion, SshBastionSyncLogEntry } from "../../../shared/ssh-contract";
import { SshActionButton } from "./SshActionButton";

export type JumpserverDetailProps = {
  bastion: SshBastion;
  status: "healthy" | "auth-expired" | "unreachable" | "syncing" | "stale";
  linuxCount: number;
  windowsCount: number;
  syncedHosts: Array<{ id: string; alias: string; user: string; hostname: string; status: string }>;
  syncLog: SshBastionSyncLogEntry[];
  busy?: string;
  onRefresh: () => void;
  onEdit: () => void;
  onRemove: () => void;
};

const statusLabel: Record<JumpserverDetailProps["status"], string> = {
  healthy: "正常",
  "auth-expired": "认证过期",
  unreachable: "不可达",
  syncing: "同步中",
  stale: "数据陈旧",
};

const statusClass: Record<JumpserverDetailProps["status"], string> = {
  healthy: "ssh-status.ready",
  "auth-expired": "ssh-status.untrusted",
  unreachable: "ssh-status.identity-changed",
  syncing: "ssh-status.syncing",
  stale: "ssh-status.untrusted",
};

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  catch { return iso; }
}

export function JumpserverDetail({
  bastion,
  status,
  linuxCount,
  windowsCount,
  syncedHosts,
  syncLog,
  busy,
  onRefresh,
  onEdit,
  onRemove,
}: JumpserverDetailProps): ReactElement {
  return (
    <aside className="ssh-details" aria-label={`${bastion.alias} 堡垒机详情`}>
      <header>
        <div className="ssh-details-heading-copy">
          <small>堡垒机</small>
          <h2>{bastion.alias}</h2>
          <span>{bastion.user}@{bastion.hostname}:{bastion.port}</span>
        </div>
        <span className={`ssh-status ${statusClass[status] ?? ""}`}>{statusLabel[status]}</span>
      </header>

      <dl>
        <div><dt>配置来源</dt><dd>~/.config/afk/jumpserver-bastions.yml</dd></div>
        <div><dt>HostName</dt><dd>{bastion.hostname}</dd></div>
        <div><dt>IdentityFile</dt><dd>{bastion.user}@{bastion.hostname}</dd></div>
        <div><dt>ProxyJump</dt><dd>—</dd></div>
        {bastion.lastSyncedAt ? (
          <div><dt>上次同步</dt><dd>{formatTimestamp(bastion.lastSyncedAt)}</dd></div>
        ) : null}
      </dl>

      <div className="ssh-detail-sync-stats">
        <div className="ssh-detail-sync-stat">
          <b>{linuxCount + windowsCount}</b>
          <small>资产</small>
        </div>
        <div className="ssh-detail-sync-stat">
          <b>{linuxCount}</b>
          <small>Linux</small>
        </div>
        <div className="ssh-detail-sync-stat">
          <b>{windowsCount}</b>
          <small>Windows</small>
        </div>
        <div className="ssh-detail-sync-stat">
          <b>{bastion.lastSyncedAt ? formatTimestamp(bastion.lastSyncedAt) : "—"}</b>
          <small>最后同步</small>
        </div>
      </div>

      <div className="ssh-detail-sync-actions">
        <SshActionButton
          size="sm"
          variant="primary"
          onClick={onRefresh}
          disabled={!!busy}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {busy === "refresh" ? "同步中…" : "刷新资产"}
        </SshActionButton>
        <SshActionButton
          size="sm"
          variant="secondary"
          onClick={onEdit}
          disabled={!!busy}
        >
          <Settings size={15} aria-hidden="true" />
          编辑堡垒机
        </SshActionButton>
        <SshActionButton
          size="sm"
          variant="danger"
          onClick={onRemove}
          disabled={!!busy}
        >
          <Trash2 size={15} aria-hidden="true" />
          删除堡垒机
        </SshActionButton>
      </div>

      {syncLog.length > 0 ? (
        <div className="ssh-sync-log">
          <small style={{ display: "block", color: "var(--afk-muted)", fontSize: "calc(10px * var(--afk-scale))", marginBottom: "8px" }}>同步日志</small>
          <div className="ssh-sync-log-entries">
            {syncLog.slice(0, 5).map((entry, i) => (
              <div key={i} className={`ssh-sync-log-entry ${entry.level}`}>
                <span className="at">{formatTimestamp(entry.at)}</span>
                <span className="msg">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {syncedHosts.length > 0 ? (
        <div className="ssh-synced-mini-list">
          <small style={{ display: "block", color: "var(--afk-muted)", fontSize: "calc(10px * var(--afk-scale))", marginBottom: "8px" }}>已同步主机</small>
          {syncedHosts.map((host) => (
            <div key={host.id} className="ssh-synced-mini-row">
              <span className="alias">{host.alias}</span>
              <span className="host">{host.user}@{host.hostname}</span>
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
