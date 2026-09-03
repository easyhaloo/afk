import { BrowserWindow, dialog, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-contract";
import type { SshFingerprint } from "../../shared/ssh-contract";
import { exec } from "../adapters/process-executor";
import { createKnownHostsAdapter } from "../adapters/known-hosts-adapter";
import { createSshCommandAdapter } from "../adapters/ssh-command-adapter";
import { createSshConfigAdapter } from "../adapters/ssh-config-adapter";
import { createSshPtyAdapter } from "../adapters/ssh-pty-adapter";
import { isAfkTmuxSession, listAfkTmux } from "../adapters/resource-adapter";
import { assertTrustedSender } from "../security/sender-guard";
import { validateSshHostId, validateSshHostInput, validateSshResize, validateSshSessionId } from "../security/ssh-validation";
import { readAppearance, saveAppearance } from "../services/appearance-service";
import { saveWorkflowConfig, snapshot } from "../services/desktop-service";
import { createSshService } from "../services/ssh-service";
import { resolveWorkspace } from "../services/workspace-service";
import { homedir } from "node:os";

function validSession(value: string) {
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
}

function broadcast(channel: string, ...args: unknown[]) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, ...args);
}

const home = homedir();
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
  config: createSshConfigAdapter({ home, exec }),
  commands,
  knownHosts,
  pty: createSshPtyAdapter({ onData: (sessionId, data) => broadcast(IPC_CHANNELS.sshData, sessionId, data), onExit: (sessionId, code) => broadcast(IPC_CHANNELS.sshExit, sessionId, code) }),
});

function fingerprintInput(value: unknown): SshFingerprint {
  if (!value || typeof value !== "object") throw new Error("SSH 指纹参数无效");
  const input = value as Record<string, unknown>;
  if (typeof input.algorithm !== "string" || typeof input.value !== "string" || typeof input.hostname !== "string" || typeof input.port !== "number") throw new Error("SSH 指纹参数无效");
  return { algorithm: input.algorithm, value: input.value, hostname: input.hostname, port: input.port, bits: typeof input.bits === "number" ? input.bits : undefined };
}

export function registerIpcHandlers() {
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
  ipcMain.handle(IPC_CHANNELS.sshList, (event) => { assertTrustedSender(event); return sshService.listHosts(); });
  ipcMain.handle(IPC_CHANNELS.sshAdd, (event, input: unknown) => { assertTrustedSender(event); return sshService.addHost(validateSshHostInput(input)); });
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
}
