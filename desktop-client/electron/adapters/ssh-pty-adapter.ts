import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { SshSession } from "../../shared/ssh-contract";
import type { SshConnectionTarget } from "../../shared/ssh-contract";
import { sshConnectionArgs } from "../../shared/ssh-contract";

type PtyProcess = {
  pid: number;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};

type SshPtySession = {
  process: PtyProcess;
  session: SshSession;
  pendingPassword?: string;
  promptBuffer: string;
};

type SshPtyAdapterOptions = {
  spawn?: (file: string, args: string[], options: pty.IPtyForkOptions) => PtyProcess;
  prepareSpawn?: () => void;
  onData?: (sessionId: string, data: string) => void;
  onExit?: (sessionId: string, code: number) => void;
};

type NodePtySpawnHelperOptions = {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};

function sessionId() {
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function unpackedPath(value: string) {
  return value.replace("app.asar", "app.asar.unpacked").replace("node_modules.asar", "node_modules.asar.unpacked");
}

function stripTerminalControlSequences(value: string) {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][0-2A-Z]/g, "")
    .replace(/\u001b[^[\]()].?/g, "");
}

function isSshPasswordPrompt(buffer: string) {
  const visible = stripTerminalControlSequences(buffer);
  const line = visible.split(/[\r\n]/).at(-1)?.trim() || "";
  return /^(?:[^:\r\n]*['’]s\s+)?password:\s*$/i.test(line);
}

export function ensureNodePtySpawnHelperExecutable({
  packageRoot = path.dirname(path.dirname(require.resolve("node-pty"))),
  platform = process.platform,
  arch = process.arch,
}: NodePtySpawnHelperOptions = {}) {
  if (platform !== "darwin") return undefined;
  const root = unpackedPath(packageRoot);
  const runtimeDirectories = [path.join(root, "build", "Release"), path.join(root, "build", "Debug"), path.join(root, "prebuilds", `${platform}-${arch}`)];
  const runtimeDirectory = runtimeDirectories.find((directory) => existsSync(path.join(directory, "pty.node")) && existsSync(path.join(directory, "spawn-helper")));
  if (!runtimeDirectory) throw new Error("未找到 node-pty 的 macOS spawn-helper");
  const helperPath = path.join(runtimeDirectory, "spawn-helper");
  chmodSync(helperPath, 0o755);
  return helperPath;
}

export function createSshPtyAdapter(options: SshPtyAdapterOptions = {}) {
  const { onData, onExit } = options;
  const spawn = options.spawn ?? pty.spawn;
  const prepareSpawn = options.prepareSpawn ?? (options.spawn ? () => undefined : ensureNodePtySpawnHelperExecutable);
  const sessions = new Map<string, SshPtySession>();
  let spawnPrepared = false;

  function open(command: string, args: string[], session: SshSession, after?: { command: string; args: string[] }, password?: string) {
    const start = (file: string, parameters: string[], chained?: { command: string; args: string[] }) => {
      if (!spawnPrepared) {
        try { prepareSpawn(); spawnPrepared = true; }
        catch (cause) { throw new Error(`无法准备 SSH 终端组件：${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      const child = spawn(file, parameters, { name: "xterm-256color", cols: 120, rows: 32, cwd: homedir(), env: globalThis.process.env });
      const item: SshPtySession = {
        process: child,
        session: { ...session, state: "open" },
        pendingPassword: session.kind === "deploy" ? password : undefined,
        promptBuffer: "",
      };
      sessions.set(session.id, item);
      child.onData((data) => {
        if (sessions.get(session.id) === item && item.pendingPassword !== undefined) {
          item.promptBuffer = `${item.promptBuffer}${data}`.slice(-1_024);
          if (isSshPasswordPrompt(item.promptBuffer)) {
            const passwordToSend = item.pendingPassword;
            item.pendingPassword = undefined;
            item.promptBuffer = "";
            child.write(`${passwordToSend}\n`);
          }
        }
        onData?.(session.id, data);
      });
      child.onExit(({ exitCode }) => {
        item.pendingPassword = undefined;
        item.promptBuffer = "";
        if (chained && exitCode === 0) { start(chained.command, chained.args); return; }
        sessions.delete(session.id);
        onExit?.(session.id, exitCode);
      });
    };
    start(command, args, after);
    return { ...session, state: "open" as const };
  }

  return {
    connect(hostId: string, targetOrAlias: SshConnectionTarget | string, displayAlias?: string) {
      const target = typeof targetOrAlias === "string" ? undefined : targetOrAlias;
      const alias = displayAlias || (typeof targetOrAlias === "string" ? targetOrAlias : targetOrAlias.hostname);
      const id = sessionId();
      return open("/usr/bin/ssh", target ? sshConnectionArgs(target) : [alias], { id, hostId, alias, kind: "ssh", title: `SSH · ${alias}`, state: "opening" });
    },
    generateKey(identityFile: string) {
      const id = sessionId();
      return open("/usr/bin/ssh-keygen", ["-t", "ed25519", "-f", identityFile, "-C", "afk-managed"], { id, hostId: "local", alias: "ssh-keygen", kind: "keygen", title: "生成 AFK Ed25519 密钥", state: "opening" }, { command: "/usr/bin/ssh-add", args: ["--apple-use-keychain", identityFile] });
    },
    deployKey(hostId: string, targetOrAlias: SshConnectionTarget | string, remoteCommand: string, password?: string, displayAlias?: string) {
      const target = typeof targetOrAlias === "string" ? undefined : targetOrAlias;
      const alias = displayAlias || (typeof targetOrAlias === "string" ? targetOrAlias : targetOrAlias.hostname);
      const id = sessionId();
      return open("/usr/bin/ssh", [...(target ? sshConnectionArgs(target) : [alias]), remoteCommand], { id, hostId, alias, kind: "deploy", title: `部署公钥 · ${alias}`, state: "opening" }, undefined, password);
    },
    input(sessionIdValue: string, data: string) {
      const item = sessions.get(sessionIdValue);
      if (!item || data.includes("\0") || data.length > 8_000) throw new Error("SSH 会话输入无效");
      item.process.write(data);
      return true;
    },
    resize(sessionIdValue: string, cols: number, rows: number) {
      const item = sessions.get(sessionIdValue);
      if (!item) throw new Error("SSH 会话不存在");
      item.process.resize(cols, rows);
      return true;
    },
    close(sessionIdValue: string) {
      const item = sessions.get(sessionIdValue);
      if (!item) return false;
      item.pendingPassword = undefined;
      item.promptBuffer = "";
      item.process.kill("SIGTERM");
      sessions.delete(sessionIdValue);
      return true;
    },
  };
}
