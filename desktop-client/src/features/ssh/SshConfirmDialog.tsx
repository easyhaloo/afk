import { useEffect, useRef, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { SshActionButton } from "./SshActionButton";

type SshConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  confirmAriaLabel: string;
  icon?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
};

export function SshConfirmDialog({ title, description, confirmLabel, confirmAriaLabel, icon = <CircleAlert size={20} aria-hidden="true" />, onConfirm, onCancel }: SshConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", dismissOnEscape);
    return () => document.removeEventListener("keydown", dismissOnEscape);
  }, [onCancel]);

  return <div className="ssh-confirm-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={dialogRef} className="ssh-confirm-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <div className="ssh-confirm-icon" aria-hidden="true">{icon}</div>
      <div className="ssh-confirm-copy"><small>请确认操作</small><h2>{title}</h2><p>{description}</p></div>
      <footer className="ssh-confirm-actions">
        <SshActionButton size="md" variant="secondary" type="button" onClick={onCancel}>取消</SshActionButton>
        <SshActionButton size="md" variant="danger" type="button" aria-label={confirmAriaLabel} onClick={onConfirm}>{confirmLabel}</SshActionButton>
      </footer>
    </div>
  </div>;
}
