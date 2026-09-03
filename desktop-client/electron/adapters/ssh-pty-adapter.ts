import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { SshSession } from "../../shared/ssh-contract";

type PtyProcess = {
  pid: number;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
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
  const sessions = new Map<string, { process: PtyProcess; session: SshSession }>();
  let spawnPrepared = false;

  function open(command: string, args: string[], session: SshSession, after?: { command: string; args: string[] }) {
    const start = (file: string, parameters: string[], chained?: { command: string; args: string[] }) => {
      if (!spawnPrepared) {
        try { prepareSpawn(); spawnPrepared = true; }
        catch (cause) { throw new Error(`无法准备 SSH 终端组件：${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      const child = spawn(file, parameters, { name: "xterm-256color", cols: 120, rows: 32, cwd: homedir(), env: globalThis.process.env });
      sessions.set(session.id, { process: child, session: { ...session, state: "open" } });
      child.onData((data) => onData?.(session.id, data));
      child.onExit(({ exitCode }) => {
        if (chained && exitCode === 0) { start(chained.command, chained.args); return; }
        sessions.delete(session.id);
        onExit?.(session.id, exitCode);
      });
    };
    start(command, args, after);
    return { ...session, state: "open" as const };
  }

  return {
    connect(hostId: string, alias: string) {
      const id = sessionId();
      return open("/usr/bin/ssh", [alias], { id, hostId, alias, kind: "ssh", title: `SSH · ${alias}`, state: "opening" });
    },
    generateKey(identityFile: string) {
      const id = sessionId();
      return open("/usr/bin/ssh-keygen", ["-t", "ed25519", "-f", identityFile, "-C", "afk-managed"], { id, hostId: "local", alias: "ssh-keygen", kind: "keygen", title: "生成 AFK Ed25519 密钥", state: "opening" }, { command: "/usr/bin/ssh-add", args: ["--apple-use-keychain", identityFile] });
    },
    deployKey(hostId: string, alias: string, remoteCommand: string) {
      const id = sessionId();
      return open("/usr/bin/ssh", [alias, remoteCommand], { id, hostId, alias, kind: "deploy", title: `部署公钥 · ${alias}`, state: "opening" });
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
      item.process.kill("SIGTERM");
      sessions.delete(sessionIdValue);
      return true;
    },
  };
}
