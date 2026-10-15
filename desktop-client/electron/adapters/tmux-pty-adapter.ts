import { homedir } from "node:os";
import * as pty from "node-pty";

// node-pty is CommonJS; ESM main has no ambient `require`, so this adapter
// mirrors ssh-pty-adapter.ts, which owns the same require dance.
type PtyProcess = {
  pid: number;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};

type AttachSession = {
  attachId: string;
  process: PtyProcess;
};

type TmuxPtyAdapterOptions = {
  spawn?: (file: string, args: string[], options: pty.IPtyForkOptions) => PtyProcess;
  onData?: (attachId: string, data: string) => void;
  onExit?: (attachId: string, code: number) => void;
};

function attachId() {
  return `attach-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Real PTY attachment to one exact registered tmux target (ADR-0019 §4).
 *
 * The PTY process IS `tmux attach-session -t <target>`; closing or killing
 * it only detaches the Desktop client. The tmux server, session, window,
 * pane, and the Runner's Agent keep running untouched.
 */
export function createTmuxAttachPtyAdapter(options: TmuxPtyAdapterOptions = {}) {
  const { onData, onExit } = options;
  const spawn = options.spawn ?? pty.spawn;
  const attaches = new Map<string, PtyProcess>();

  return {
    attach(target: string, cols = 120, rows = 32) {
      const id = attachId();
      const child = spawn("tmux", ["attach-session", "-t", target], {
        name: "xterm-256color", cols, rows, cwd: homedir(), env: globalThis.process.env,
      }) as unknown as PtyProcess;
      attaches.set(id, child);
      child.onData(data => onData?.(id, data));
      child.onExit(({ exitCode }) => {
        attaches.delete(id);
        onExit?.(id, exitCode);
      });
      return id;
    },
    input(attachIdValue: string, data: string) {
      const child = attaches.get(attachIdValue);
      if (!child || data.includes("\0") || data.length > 8_000) throw new Error("终端输入无效");
      child.write(data);
      return true;
    },
    resize(attachIdValue: string, cols: number, rows: number) {
      const child = attaches.get(attachIdValue);
      if (!child) throw new Error("附加会话不存在");
      child.resize(cols, rows);
      return true;
    },
    detach(attachIdValue: string) {
      const child = attaches.get(attachIdValue);
      if (!child) return false;
      attaches.delete(attachIdValue);
      child.kill();
      return true;
    },
  };
}
