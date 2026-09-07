import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from "electron";
import { IPC_CHANNELS, type SshCredentialSetInput, type SshListOptions } from "../../shared/ipc-contract";
import type { SshFingerprint } from "../../shared/ssh-contract";
import { parseBacklogCreateInput, parseBacklogListOptions, type BacklogPlatform } from "../../shared/backlog-contract";
import { exec } from "../adapters/process-executor";
import { createKnownHostsAdapter } from "../adapters/known-hosts-adapter";
import { createSshCommandAdapter } from "../adapters/ssh-command-adapter";
import { createSshConfigAdapter } from "../adapters/ssh-config-adapter";
import { createSshManagedHostStore } from "../adapters/ssh-managed-host-store";
import { createSshPtyAdapter } from "../adapters/ssh-pty-adapter";
import { createExternalTerminalAdapter } from "../adapters/external-terminal-adapter";
import { isAfkTmuxSession, listAfkTmux } from "../adapters/resource-adapter";
import { assertTrustedSender } from "../security/sender-guard";
import { validateSshExternalTerminalId, validateSshHostId, validateSshHostInput, validateSshResize, validateSshSessionId } from "../security/ssh-validation";
import { readAppearance, saveAppearance } from "../services/appearance-service";
import { createBacklogService } from "../services/backlog-service";
import { createClipboardService } from "../services/clipboard-service";
import { createSshCredentialService } from "../services/ssh-credential-service";
import { saveWorkflowConfig, snapshot } from "../services/desktop-service";
import { createSshService } from "../services/ssh-service";
import { resolveWorkspace } from "../services/workspace-service";
import { homedir } from "node:os";
import path from "node:path";

function validSession(value: string) {
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
}

function broadcast(channel: string, ...args: unknown[]) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, ...args);
}

const home = homedir();
const sshManagedHostStore = createSshManagedHostStore({ file: path.join(app.getPath("userData"), "ssh-hosts.yml") });
const clipboardService = createClipboardService({ writeText: (text) => clipboard.writeText(text) });
const sshCredentialService = createSshCredentialService({ home, safeStorage });
const commands = createSshCommandAdapter({ exec });
const knownHosts = createKnownHostsAdapter({
  home,
  scan: async (target) => {
    const result = await exec("ssh-keyscan", ["-T", "8", "-p", String(target.port), target.hostname]);
    if (!result.ok) throw new Error("SSH 主机指纹扫描失败");
    return result.stdout;
  },
  fingerprint: commands.scanFingerprint,
});
const sshService = createSshService({
  home,
  config: createSshConfigAdapter({ home, exec, managedStore: sshManagedHostStore }),
  commands,
  knownHosts,
  credentialService: sshCredentialService,
  externalTerminal: createExternalTerminalAdapter(),
  pty: createSshPtyAdapter({ onData: (sessionId, data) => broadcast(IPC_CHANNELS.sshData, sessionId, data), onExit: (sessionId, code) => broadcast(IPC_CHANNELS.sshExit, sessionId, code) }),
});
const backlogService = createBacklogService({
  resolveAfk: async () => {
    const result = await exec("/usr/bin/which", ["afk"]);
    if (!result.ok) return "";
    const candidate = result.stdout.split("\n")[0]?.trim() ?? "";
    return candidate && candidate.startsWith("/") ? candidate : "";
  },
  resolveWorkspace,
  exec: async (command, args, cwd, stdin) => {
    const result = await exec(command, args, cwd, stdin);
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
  },
});

function fingerprintInput(value: unknown): SshFingerprint {
  if (!value || typeof value !== "object") throw new Error("SSH 指纹参数无效");
  const input = value as Record<string, unknown>;
  if (typeof input.algorithm !== "string" || typeof input.value !== "string" || typeof input.hostname !== "string" || typeof input.port !== "number") throw new Error("SSH 指纹参数无效");
  return { algorithm: input.algorithm, value: input.value, hostname: input.hostname, port: input.port, bits: typeof input.bits === "number" ? input.bits : undefined };
}

function sshListOptions(value: unknown): SshListOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SSH 列表参数无效");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "forceRefresh") || ("forceRefresh" in input && typeof input.forceRefresh !== "boolean")) throw new Error("SSH 列表参数无效");
  return "forceRefresh" in input ? { forceRefresh: input.forceRefresh as boolean } : {};
}

function sshCredentialSetInput(value: unknown): SshCredentialSetInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SSH 凭据参数无效");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "hostId" && key !== "password") || !Object.prototype.hasOwnProperty.call(input, "hostId") || !Object.prototype.hasOwnProperty.call(input, "password")) throw new Error("SSH 凭据参数无效");
  const hostId = validateSshHostId(input.hostId);
  if (typeof input.password !== "string" || !input.password || input.password.includes("\0") || input.password.includes("\r") || input.password.includes("\n") || Buffer.byteLength(input.password, "utf8") > 4096) throw new Error("SSH 部署密码无效");
  return { hostId, password: input.password };
}

export function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.copyText, (event, text: unknown) => { assertTrustedSender(event); return clipboardService.copyText(text); });
  ipcMain.handle(IPC_CHANNELS.chooseWorkspace, async (event) => {
    assertTrustedSender(event);
    const selected = await dialog.showOpenDialog({ title: "选择 AFK 工作区", properties: ["openDirectory"] });
    return selected.canceled ? null : selected.filePaths[0] || null;
  });
  ipcMain.handle(IPC_CHANNELS.snapshot, (event, workspace: string) => { assertTrustedSender(event); return snapshot(workspace); });
  ipcMain.handle(IPC_CHANNELS.appearance, (event) => { assertTrustedSender(event); return readAppearance(); });
  ipcMain.handle(IPC_CHANNELS.appearanceSave, (event, appearance: unknown) => { assertTrustedSender(event); return saveAppearance(appearance); });
  ipcMain.handle(IPC_CHANNELS.workflowSave, (event, workspace: string, workflow: unknown) => { assertTrustedSender(event); return saveWorkflowConfig(workspace, workflow); });
  ipcMain.handle(IPC_CHANNELS.tmuxPane, async (event, workspace: string, name: string) => {
    assertTrustedSender(event);
    const root = resolveWorkspace(workspace);
    if (!validSession(name) || !isAfkTmuxSession(root, name) || !(await listAfkTmux(root)).some((item) => item.name === name)) throw new Error("tmux 会话不是当前 AFK 工作区登记的资源，或已不存在");
    const result = await exec("tmux", ["capture-pane", "-p", "-t", name, "-S", "-160"]);
    if (!result.ok) throw new Error(result.stderr);
    return result.stdout;
  });
  ipcMain.handle(IPC_CHANNELS.tmuxSend, async (event, workspace: string, name: string, line: string) => {
    assertTrustedSender(event);
    const root = resolveWorkspace(workspace);
    if (!validSession(name) || !isAfkTmuxSession(root, name) || !(await listAfkTmux(root)).some((item) => item.name === name)) throw new Error("tmux 会话不是当前 AFK 工作区登记的资源，或已不存在");
    if (!line.trim() || line.length > 4_000 || line.includes("\0")) throw new Error("接管输入为空或超过安全长度");
    const result = await exec("tmux", ["send-keys", "-t", name, line, "Enter"]);
    if (!result.ok) throw new Error(result.stderr);
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.sshList, (event, options: unknown) => {
    assertTrustedSender(event);
    const validated = sshListOptions(options);
    return validated === undefined ? sshService.listHosts() : sshService.listHosts(validated);
  });
  ipcMain.handle(IPC_CHANNELS.sshAdd, (event, input: unknown) => { assertTrustedSender(event); return sshService.addHost(validateSshHostInput(input)); });
  ipcMain.handle(IPC_CHANNELS.sshUpdate, (event, hostId: unknown, input: unknown) => { assertTrustedSender(event); return sshService.updateHost(validateSshHostId(hostId), validateSshHostInput(input)); });
  ipcMain.handle(IPC_CHANNELS.sshRemove, (event, hostId: unknown) => { assertTrustedSender(event); return sshService.removeHost(validateSshHostId(hostId)); });
  ipcMain.handle(IPC_CHANNELS.sshTrust, (event, request: unknown) => {
    assertTrustedSender(event);
    if (!request || typeof request !== "object") throw new Error("SSH 信任参数无效");
    const input = request as Record<string, unknown>;
    return sshService.trustFingerprint({ hostId: validateSshHostId(input.hostId), fingerprint: fingerprintInput(input.fingerprint) });
  });
  ipcMain.handle(IPC_CHANNELS.sshGenerateKey, (event) => { assertTrustedSender(event); return sshService.generateKey(); });
  ipcMain.handle(IPC_CHANNELS.sshDeployKey, (event, hostId: unknown) => { assertTrustedSender(event); return sshService.deployKey(validateSshHostId(hostId)); });
  ipcMain.handle(IPC_CHANNELS.sshTest, (event, hostId: unknown) => { assertTrustedSender(event); return sshService.testHost(validateSshHostId(hostId)); });
  ipcMain.handle(IPC_CHANNELS.sshConnect, (event, hostId: unknown) => { assertTrustedSender(event); return sshService.connect(validateSshHostId(hostId)); });
  ipcMain.handle(IPC_CHANNELS.sshOpenExternal, (event, hostId: unknown, terminal: unknown) => { assertTrustedSender(event); return sshService.openExternal(validateSshHostId(hostId), terminal === undefined ? "iterm2" : validateSshExternalTerminalId(terminal)); });
  ipcMain.handle(IPC_CHANNELS.sshCredentialHas, (event, hostId: unknown) => { assertTrustedSender(event); return sshService.hasCredential(validateSshHostId(hostId)); });
  ipcMain.handle(IPC_CHANNELS.sshCredentialSet, (event, input: unknown) => { assertTrustedSender(event); const validated = sshCredentialSetInput(input); return sshService.setCredential(validated.hostId, validated.password); });
  ipcMain.handle(IPC_CHANNELS.sshCredentialRemove, (event, hostId: unknown) => { assertTrustedSender(event); return sshService.removeCredential(validateSshHostId(hostId)); });
  ipcMain.handle(IPC_CHANNELS.sshInput, (event, request: unknown) => {
    assertTrustedSender(event);
    if (!request || typeof request !== "object") throw new Error("SSH 输入参数无效");
    const input = request as Record<string, unknown>;
    if (typeof input.data !== "string") throw new Error("SSH 输入参数无效");
    return sshService.input(validateSshSessionId(input.sessionId), input.data);
  });
  ipcMain.handle(IPC_CHANNELS.sshResize, (event, request: unknown) => {
    assertTrustedSender(event);
    if (!request || typeof request !== "object") throw new Error("SSH 尺寸参数无效");
    const input = request as Record<string, unknown>;
    const size = validateSshResize(input.cols, input.rows);
    return sshService.resize(validateSshSessionId(input.sessionId), size.cols, size.rows);
  });
  ipcMain.handle(IPC_CHANNELS.sshClose, (event, sessionId: unknown) => { assertTrustedSender(event); return sshService.close(validateSshSessionId(sessionId)); });

  ipcMain.handle(IPC_CHANNELS.backlogList, (event, workspace: unknown, options: unknown) => {
    assertTrustedSender(event);
    if (typeof workspace !== "string") throw new Error("backlog.list: workspace 必须是字符串");
    return backlogService.list(workspace, parseBacklogListOptions(options));
  });
  ipcMain.handle(IPC_CHANNELS.backlogShow, (event, workspace: unknown, id: unknown) => {
    assertTrustedSender(event);
    if (typeof workspace !== "string") throw new Error("backlog.show: workspace 必须是字符串");
    if (typeof id !== "string" || !id) throw new Error("backlog.show: id 必须是字符串");
    return backlogService.show(workspace, id);
  });
  ipcMain.handle(IPC_CHANNELS.backlogCreate, (event, workspace: unknown, input: unknown) => {
    assertTrustedSender(event);
    if (typeof workspace !== "string") throw new Error("backlog.create: workspace 必须是字符串");
    return backlogService.create(workspace, parseBacklogCreateInput(input));
  });
  ipcMain.handle(IPC_CHANNELS.backlogTagAdd, (event, workspace: unknown, id: unknown, tag: unknown) => {
    assertTrustedSender(event);
    if (typeof workspace !== "string") throw new Error("backlog.tag.add: workspace 必须是字符串");
    if (typeof id !== "string" || !id) throw new Error("backlog.tag.add: id 必须是字符串");
    if (typeof tag !== "string" || !tag) throw new Error("backlog.tag.add: tag 必须是字符串");
    return backlogService.addTag(workspace, id, tag);
  });
  ipcMain.handle(IPC_CHANNELS.backlogTagRemove, (event, workspace: unknown, id: unknown, tag: unknown) => {
    assertTrustedSender(event);
    if (typeof workspace !== "string") throw new Error("backlog.tag.remove: workspace 必须是字符串");
    if (typeof id !== "string" || !id) throw new Error("backlog.tag.remove: id 必须是字符串");
    if (typeof tag !== "string" || !tag) throw new Error("backlog.tag.remove: tag 必须是字符串");
    return backlogService.removeTag(workspace, id, tag);
  });
}
