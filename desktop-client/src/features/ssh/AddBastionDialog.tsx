import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, RefreshCw, X } from "lucide-react";
import type { ManagedSshHostInput, SshBastionAssetPreview, SshBastionSyncResult, SshHost, SshJumpHostType } from "../../../shared/ssh-contract";
import { SshActionButton } from "./SshActionButton";
import { SshFormPicker } from "./SshHostsPage";
import "./ssh.css";

const modalFocusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(modalFocusableSelector)).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

const jumpHostTypeLabels: Record<"none" | SshJumpHostType, string> = { none: "不使用跳板机", openssh: "OpenSSH ProxyJump", jumpserver: "JumpServer" };

export type AddBastionDialogProps = {
  open: boolean;
  initialMode?: "ssh" | "bastion";
  onClose: () => void;
  // For SSH mode (existing flow):
  sshForm: ManagedSshHostInput;
  sshEditingId: string;
  sshAddPassword: string;
  jumpHostCandidates: SshHost[];
  onSshFormChange: (form: ManagedSshHostInput) => void;
  onSshPasswordChange: (password: string) => void;
  onSshSubmit: () => Promise<void>;
  // For Bastion mode (new flow):
  bastionAlias: string;
  bastionHost: string;
  bastionPort: number;
  bastionUser: string;
  bastionPassword: string;
  bastionOtp: string;
  bastionLinuxOnly: boolean;
  onBastionFieldChange: (field: "alias" | "host" | "port" | "user" | "password" | "otp" | "linuxOnly", value: string | number | boolean) => void;
  bastionTestState: "idle" | "testing" | "preview" | "error";
  bastionTestError?: string;
  bastionPreview: SshBastionAssetPreview[];
  bastionSelectedNames: Set<string>;
  bastionSyncing: boolean;
  bastionSyncError?: string;
  bastionSyncResult?: SshBastionSyncResult;
  onBastionTest: () => Promise<void>;
  onBastionToggleAsset: (name: string) => void;
  onBastionSync: () => Promise<void>;
  onBastionClearError: () => void;
  // Common
  busy: boolean;
};

export function AddBastionDialog({
  open,
  initialMode = "ssh",
  onClose,
  sshForm,
  sshEditingId,
  sshAddPassword,
  jumpHostCandidates,
  onSshFormChange,
  onSshPasswordChange,
  onSshSubmit,
  bastionAlias,
  bastionHost,
  bastionPort,
  bastionUser,
  bastionPassword,
  bastionOtp,
  bastionLinuxOnly,
  onBastionFieldChange,
  bastionTestState,
  bastionTestError,
  bastionPreview,
  bastionSelectedNames,
  bastionSyncing,
  bastionSyncError,
  bastionSyncResult,
  onBastionTest,
  onBastionToggleAsset,
  onBastionSync,
  onBastionClearError,
  busy,
}: AddBastionDialogProps) {
  const [mode, setMode] = useState<"ssh" | "bastion">(initialMode);
  const modalRef = useRef<HTMLFormElement>(null);

  // Sync mode when initialMode changes (for external control)
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  // Focus trap
  useEffect(() => {
    if (!open) return;
    const modal = modalRef.current;
    if (!modal) return;
    getFocusableElements(modal)[0]?.focus();
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown, true);
  }, [open, onClose]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const focusableElements = getFocusableElements(event.currentTarget);
    if (!focusableElements.length) return;
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstFocusable) {
      event.preventDefault();
      lastFocusable.focus();
    } else if (!event.shiftKey && document.activeElement === lastFocusable) {
      event.preventDefault();
      firstFocusable.focus();
    }
  }, []);

  if (!open) return null;

  const formTitle = mode === "bastion" ? "添加堡垒机" : sshEditingId ? "编辑 SSH 主机" : "复制 SSH 主机";

  const renderSshForm = () => (
    <>
      <label>显示名称<input required value={sshForm.alias} onChange={(e) => onSshFormChange({ ...sshForm, alias: e.target.value })} placeholder="例如：kg演示" /></label>
      <label>主机地址或 IP<input required value={sshForm.hostname} onChange={(e) => onSshFormChange({ ...sshForm, hostname: e.target.value })} placeholder="172.16.0.241" /></label>
      <div className="ssh-form-row">
        <label>端口<input type="number" min="1" max="65535" value={sshForm.port} onChange={(e) => onSshFormChange({ ...sshForm, port: Number(e.target.value) })} /></label>
        <label>用户<input value={sshForm.user || ""} onChange={(e) => onSshFormChange({ ...sshForm, user: e.target.value })} placeholder="deploy" /></label>
      </div>
      {!sshEditingId ? <label>部署密码（可选）<input type="password" autoComplete="new-password" aria-label="添加主机部署密码" value={sshAddPassword} onChange={(e) => onSshPasswordChange(e.target.value)} placeholder="用于首次部署公钥，保存到系统安全存储" /></label> : null}
      <label>已有私钥路径（可选）<input value={sshForm.identityFile || ""} onChange={(e) => onSshFormChange({ ...sshForm, identityFile: e.target.value || undefined })} placeholder="~/.ssh/id_ed25519" /><small>留空则解析 ~/.ssh/config 中该别名的 IdentityFile，再降级到 AFK 默认密钥</small></label>
      <label>上传目录（可选）<input value={sshForm.remoteWorkspace || ""} onChange={(e) => onSshFormChange({ ...sshForm, remoteWorkspace: e.target.value || undefined })} placeholder="例如：~/uploads" /></label>
      <label>跳板机类型（可选）<SshFormPicker id="ssh-jump-host-type" ariaLabel="选择跳板机类型" value={sshForm.jumpHostType || "none"} options={Object.entries(jumpHostTypeLabels).map(([value, label]) => ({ value, label }))} placeholder="请选择跳板机类型" onChange={(value) => { const jumpHostType = value as SshJumpHostType; onSshFormChange({ ...sshForm, jumpHostType, jumpHost: jumpHostType === "none" ? undefined : sshForm.jumpHost }); }} /></label>
      {sshForm.jumpHostType && sshForm.jumpHostType !== "none" ? <label>{jumpHostTypeLabels[sshForm.jumpHostType]}（可选）<SshFormPicker id="ssh-jump-host" ariaLabel="选择跳板机" value={sshForm.jumpHost || ""} options={jumpHostCandidates.map((host) => ({ value: host.alias, label: host.alias, description: `${host.user ? `${host.user}@` : ""}${host.hostname}:${host.port}` }))} placeholder="请选择已配置的 SSH 主机" required onChange={(value) => onSshFormChange({ ...sshForm, jumpHost: value || "" })} /></label> : null}
    </>
  );

  const renderBastionForm = () => (
    <>
      <label>显示名称<input value={bastionAlias} onChange={(e) => onBastionFieldChange("alias", e.target.value)} placeholder="例如：dev-jumpserver-wangwendi" /></label>
      <label>JumpServer URL<input value={bastionHost} onChange={(e) => onBastionFieldChange("host", e.target.value)} placeholder="dev-jumpserver.fangcloud.net" /></label>
      <div className="ssh-form-row">
        <label>端口<input type="number" min="1" max="65535" value={bastionPort} onChange={(e) => onBastionFieldChange("port", Number(e.target.value))} placeholder="2222" /></label>
        <label>用户名<input value={bastionUser} onChange={(e) => onBastionFieldChange("user", e.target.value)} placeholder="wangwendi" /></label>
      </div>
      <label>密码 (保存到系统安全存储)<input type="password" value={bastionPassword} onChange={(e) => onBastionFieldChange("password", e.target.value)} /></label>
      <label>OTP 密钥 (可选)<input value={bastionOtp} onChange={(e) => onBastionFieldChange("otp", e.target.value)} placeholder="JBSWY3DPEHPK3PXP" /></label>

      {bastionTestState === "idle" && (
        <SshActionButton type="button" variant="primary" onClick={onBastionTest} disabled={busy || !bastionHost || !bastionUser || !bastionPassword}>
          <RefreshCw size={15} /> Test Connection & Preview Assets
        </SshActionButton>
      )}
      {bastionTestState === "testing" && <p className="ssh-action-status">正在测试连接…</p>}
      {bastionTestState === "error" && bastionTestError && (
        <div className="ssh-alert error" role="alert">
          <CircleAlert size={15} />{bastionTestError}<button onClick={onBastionClearError} aria-label="关闭错误">×</button>
        </div>
      )}
      {bastionTestState === "preview" && bastionPreview.length > 0 && (
        <div className="ssh-bastion-preview">
          <div className="ssh-bastion-preview-header">
            <b>✓ Login OK · {bastionPreview.length} assets discovered</b>
            <label className="ssh-bastion-linux-only">
              <input type="checkbox" checked={bastionLinuxOnly} onChange={(e) => onBastionFieldChange("linuxOnly", e.target.checked)} /> Linux only
            </label>
          </div>
          <div className="ssh-bastion-preview-table">
            {bastionPreview.map((asset) => (
              <label key={asset.name} className="ssh-bastion-preview-row">
                <input type="checkbox" checked={bastionSelectedNames.has(asset.name)} onChange={() => onBastionToggleAsset(asset.name)} />
                <span className="alias">{asset.name}</span>
                <span className="host">{asset.address}</span>
                <span className={`platform ${asset.platform.toLowerCase().startsWith("linux") ? "linux" : "windows"}`}>{asset.platform}</span>
              </label>
            ))}
          </div>
          <p className="ssh-preview-note">Windows 资产默认跳过（除非要包含）。</p>
        </div>
      )}

      {bastionSyncError && (
        <div className="ssh-alert error" role="alert">
          <CircleAlert size={15} />{bastionSyncError}
        </div>
      )}
      {bastionSyncResult && (
        <div className="ssh-alert success" role="status">
          <Check size={15} />Imported {bastionSyncResult.assetsCreated} hosts as managed.{bastionSyncResult.assetsSkipped > 0 && ` Skipped ${bastionSyncResult.assetsSkipped}.`}
        </div>
      )}
    </>
  );

  return (
    <div className="ssh-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        ref={modalRef}
        className="ssh-modal"
        role="dialog"
        aria-modal="true"
        onKeyDown={handleKeyDown}
        onSubmit={(e) => { e.preventDefault(); void onSshSubmit(); }}
      >
        <header>
          <div>
            <small>AFK 管理</small>
            <h2>{formTitle}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        {!sshEditingId && (
          <div className="ssh-form-mode-toggle">
            <button type="button" className={mode === "ssh" ? "active" : ""} onClick={() => setMode("ssh")}>添加 SSH 主机</button>
            <button type="button" className={mode === "bastion" ? "active" : ""} onClick={() => setMode("bastion")}>添加堡垒机</button>
          </div>
        )}

        {mode === "ssh" ? renderSshForm() : renderBastionForm()}

        <footer>
          <SshActionButton variant="secondary" type="button" onClick={onClose}>取消</SshActionButton>
          {mode === "bastion" && bastionTestState === "preview" && (
            <SshActionButton variant="primary" type="button" onClick={onBastionSync} disabled={bastionSyncing || bastionSelectedNames.size === 0}>
              {bastionSyncing ? "同步中…" : `Sync ✓ (${bastionSelectedNames.size})`}
            </SshActionButton>
          )}
          {mode === "ssh" && (() => {
            const label = busy ? "保存中…" : sshEditingId ? "保存修改" : "保存主机";
            return <SshActionButton variant="primary" type="submit" disabled={!!busy}>{label}</SshActionButton>;
          })()}
        </footer>
      </form>
    </div>
  );
}
