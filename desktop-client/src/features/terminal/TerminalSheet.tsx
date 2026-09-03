import { Send, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { SshSession } from "../../../shared/ssh-contract";

type TerminalSheetProps = { mode?: "tmux" | "ssh"; session: string; pane: string; line: string; confirmed: boolean; sshSession?: SshSession; onClose: () => void; onLine: (value: string) => void; onConfirmed: (value: boolean) => void; onSend: () => void; onSshInput?: (data: string) => void };

function keyData(event: React.KeyboardEvent) {
  if (event.ctrlKey && event.key.length === 1) return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
  if (event.key === "Enter") return "\r";
  if (event.key === "Backspace") return "\b";
  if (event.key === "Tab") return "\t";
  if (event.key === "Escape") return "\u001b";
  if (event.key === "ArrowUp") return "\u001b[A";
  if (event.key === "ArrowDown") return "\u001b[B";
  if (event.key === "ArrowRight") return "\u001b[C";
  if (event.key === "ArrowLeft") return "\u001b[D";
  return event.key.length === 1 ? event.key : "";
}

export function TerminalSheet({ mode = "tmux", session, pane, line, confirmed, sshSession, onClose, onLine, onConfirmed, onSend, onSshInput }: TerminalSheetProps) {
  const panelRef = useRef<HTMLElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && panelRef.current && !panelRef.current.contains(event.target)) onClose(); };
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismissOnEscape); };
  }, [onClose]);
  useEffect(() => { if (mode === "ssh") outputRef.current?.focus(); }, [mode]);
  const sshKeyDown = (event: React.KeyboardEvent<HTMLPreElement>) => { const data = keyData(event); if (!data || !onSshInput) return; event.preventDefault(); onSshInput(data); };
  return <section className="terminal-sheet" ref={panelRef}><header><div><TerminalSquare size={17} /><strong>{mode === "ssh" ? sshSession?.title || "SSH 终端" : "终端"}</strong><span>{mode === "ssh" ? sshSession?.alias : session || "未选择 tmux 会话"}</span></div><button className="icon-button" onClick={onClose} aria-label="关闭终端"><X size={16} /></button></header><pre ref={outputRef} tabIndex={mode === "ssh" ? 0 : undefined} onKeyDown={mode === "ssh" ? sshKeyDown : undefined} onPaste={mode === "ssh" ? (event) => { event.preventDefault(); onSshInput?.(event.clipboardData.getData("text")); } : undefined}>{pane || (mode === "ssh" ? "正在打开 SSH 会话…" : "没有可用的 tmux 会话。")}</pre>{mode === "ssh" ? <footer><small className="terminal-hint">点击输出区域后直接输入；密码和密钥口令不会保存到 AFK。</small></footer> : <footer><label><input type="checkbox" checked={confirmed} onChange={(event) => onConfirmed(event.target.checked)} />确认发送到此 tmux 会话</label><div><input value={line} onChange={(event) => onLine(event.target.value)} placeholder="输入一行命令或文本" onKeyDown={(event) => { if (event.key === "Enter") onSend(); }} /><button className="send" disabled={!confirmed || !line.trim()} onClick={onSend}><Send size={15} />发送</button></div></footer>}</section>;
}
