import { Send, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SshSession } from "../../../shared/ssh-contract";
import { SshTerminalView, sshTerminalErrorMessage } from "./SshTerminalView";

type MaybePromise = Promise<unknown> | void;

type TerminalSheetProps = {
  mode?: "tmux" | "ssh";
  session: string;
  pane: string;
  line: string;
  confirmed: boolean;
  sshSession?: SshSession;
  onClose(): void;
  onLine(value: string): void;
  onConfirmed(value: boolean): void;
  onSend(): void;
  onSshInput?(data: string): MaybePromise;
  onSshResize?(cols: number, rows: number): MaybePromise;
};

export function TerminalSheet({ mode = "tmux", session, pane, line, confirmed, sshSession, onClose, onLine, onConfirmed, onSend, onSshInput, onSshResize }: TerminalSheetProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [terminalError, setTerminalError] = useState("");

  useEffect(() => {
    setTerminalError("");
  }, [sshSession?.id]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current && !panelRef.current.contains(event.target)) onClose();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (mode === "tmux" && event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [mode, onClose]);

  const sshDisabled = sshSession?.state === "closed" || sshSession?.state === "failed";
  return (
    <section className={`terminal-sheet${mode === "ssh" ? " ssh-terminal-sheet" : ""}`} ref={panelRef}>
      <header>
        <div><TerminalSquare size={17} /><strong>{mode === "ssh" ? sshSession?.title || "SSH 终端" : "终端"}</strong><span>{mode === "ssh" ? sshSession?.alias : session || "未选择 tmux 会话"}</span></div>
        <button className="icon-button" onClick={onClose} aria-label="关闭终端"><X size={16} /></button>
      </header>
      {mode === "ssh" && sshSession ? (
        <>
          <SshTerminalView
            sessionId={sshSession.id}
            output={pane}
            disabled={sshDisabled}
            onInput={(data) => onSshInput?.(data)}
            onResize={(cols, rows) => onSshResize?.(cols, rows)}
            onCopy={(data) => window.afkDesktop.copyText(data)}
            onError={(operation) => setTerminalError(sshTerminalErrorMessage(operation))}
          />
          <footer>
            <small className={`terminal-hint${terminalError ? " error" : ""}`}>
              {terminalError || (sshDisabled ? "SSH 会话已结束，请关闭后重新连接。" : "终端支持中文组合输入、ANSI 显示和系统复制快捷键；密码与密钥口令不会保存到 AFK。")}
            </small>
          </footer>
        </>
      ) : (
        <>
          <pre>{pane || "没有可用的 tmux 会话。"}</pre>
          <footer>
            <label><input type="checkbox" checked={confirmed} onChange={(event) => onConfirmed(event.target.checked)} />确认发送到此 tmux 会话</label>
            <div><input value={line} onChange={(event) => onLine(event.target.value)} placeholder="输入一行命令或文本" onKeyDown={(event) => { if (event.key === "Enter") onSend(); }} /><button className="send" disabled={!confirmed || !line.trim()} onClick={onSend}><Send size={15} />发送</button></div>
          </footer>
        </>
      )}
    </section>
  );
}
