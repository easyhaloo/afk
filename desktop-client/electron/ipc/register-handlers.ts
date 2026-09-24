import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import { IPC_CHANNELS, type SshCredentialSetInput, type SshListOptions } from "../../shared/ipc-contract";
import type { SshFingerprint } from "../../shared/ssh-contract";
import { parseBacklogCreateInput, parseBacklogId, parseBacklogListOptions, parseBacklogRunRetryInput, parseBacklogRunStartInput, parseWorkItemInventoryOptions, parseWorkItemRunStartInput, type BacklogPlatform } from "../../shared/backlog-contract";
import { exec } from "../adapters/process-executor";
import { createKnownHostsAdapter } from "../adapters/known-hosts-adapter";
import { createSshCommandAdapter } from "../adapters/ssh-command-adapter";
import { createSshConfigAdapter } from "../adapters/ssh-config-adapter";
import { createSshManagedHostStore } from "../adapters/ssh-managed-host-store";
import { createSshPtyAdapter } from "../adapters/ssh-pty-adapter";
import { createExternalTerminalAdapter } from "../adapters/external-terminal-adapter";
import { isAfkTmuxSession, listAfkTmux } from "../adapters/resource-adapter";
import { assertTrustedSender } from "../security/sender-guard";
import { validateJumpserverBastionId, validateJumpserverBastionInput, validateJumpserverSyncOptions, validateSshExternalTerminalId, validateSshHostId, validateSshHostInput, validateSshResize, validateSshSessionId } from "../security/ssh-validation";
import { readAppearance, saveAppearance } from "../services/appearance-service";
import { createBacklogService } from "../services/backlog-service";
import { createBacklogExecutionService } from "../services/backlog-execution-service";
import { createBacklogRunStore } from "../services/backlog-run-store";
import { createBacklogRuntimeService } from "../services/backlog-runtime-service";
import { createClipboardService } from "../services/clipboard-service";
import { createSshCredentialService } from "../services/ssh-credential-service";
import { createJumpserverService } from "../services/jumpserver-service";
import { createJumpserverCredentialService } from "../services/jumpserver-credential-service";
import { saveWorkflowConfig, snapshot } from "../services/desktop-service";
import { createSshService } from "../services/ssh-service";
import { createExternalUrlService } from "../services/external-url-service";
import { createWorkItemInventoryService } from "../services/work-item-inventory-service";
import { createWorkItemInventoryStore } from "../services/work-item-inventory-store";
import { createWorkItemInventorySyncService } from "../services/work-item-inventory-sync-service";
import { createWorkItemExecutionService } from "../services/work-item-execution-service";
import { createWorkItemExecutionManifestStore } from "../services/work-item-execution-manifest-store";
import { createWorkItemRunStore } from "../services/work-item-run-store";
import { createWorkItemRunHistoryService } from "../services/work-item-run-history-service";
import { resolveWorkItemCli } from "../services/work-item-cli-service";
import { createExecutionWorkspaceService } from "../services/execution-workspace-service";
import { WorkflowGraphService } from "../services/graph-service";
import { saveWorkspacePreference } from "../services/workspace-preference-service";
import { resolveWorkspace } from "../services/workspace-service";
import { homedir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import { parseWorkflowGraphGenerateRequest, validateWorkflowGraphTemplateId, validateWorkflowGraphWorkspace } from "../security/graph-validation";

type HandlerSchema = (value: unknown) => unknown;

type HandlerArgs<Schemas extends readonly HandlerSchema[]> = {
  [K in keyof Schemas]: Schemas[K] extends (value: unknown) => infer Result ? Result : never;
};

function registerHandler<Schema extends (value: unknown) => unknown>(
  channel: string,
  schema: Schema,
  fn: (input: ReturnType<Schema>) => unknown,
) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    assertTrustedSender(event);
    try {
      return await fn(schema(input) as ReturnType<Schema>);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });
}

function registerHandlerMulti<Schemas extends [HandlerSchema, ...HandlerSchema[]]>(
  channel: string,
  argSchemas: readonly [...Schemas],
  fn: (args: HandlerArgs<Schemas>) => unknown,
) {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    try {
      const validated = args.map((arg, i) => argSchemas[i](arg) as unknown) as HandlerArgs<Schemas>;
      return await fn(validated);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });
}

function validSession(value: string) {
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
}

function backlogWorkspace(value: unknown, operation: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${operation}: workspace 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed && !path.isAbsolute(trimmed)) throw new Error(`${operation}: workspace 必须是绝对路径`);
  return resolveWorkspace(trimmed);
}

function broadcast(channel: string, ...args: unknown[]) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, ...args);
}

const home = homedir();
const sshManagedHostStore = createSshManagedHostStore({ file: path.join(app.getPath("userData"), "ssh-hosts.yml") });
const clipboardService = createClipboardService({ writeText: (text) => clipboard.writeText(text) });
const externalUrlService = createExternalUrlService({ openExternal: (url) => shell.openExternal(url) });
const sshCredentialService = createSshCredentialService({ home, safeStorage });
const defaultJumpserverService = createJumpserverService({
  home,
  credentialService: createJumpserverCredentialService({ home, safeStorage }),
  managedHostStore: sshManagedHostStore,
  listManagedHosts: async () => ({ hosts: await sshManagedHostStore.list() }),
});
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
const workItemInventoryService = createWorkItemInventoryService({
  cwd: app.getPath("userData"),
  store: createWorkItemInventoryStore(path.join(app.getPath("userData"), "work-item-inventory.json")),
  resolveAfk: async () => {
    if (process.env.AFK_DESKTOP_CLI) return { command: process.env.AFK_DESKTOP_CLI, args: [] };
    const localEntry = path.resolve(app.getAppPath(), "../dist/index.js");
    try {
      await access(localEntry);
      const node = await exec("/usr/bin/which", ["node"]);
      const nodePath = node.ok ? node.stdout.split("\n")[0]?.trim() ?? "" : "";
      if (nodePath.startsWith("/")) return { command: nodePath, args: [localEntry] };
    } catch {
      // Fall through to an installed AFK CLI for packaged applications.
    }
    const result = await exec("/usr/bin/which", ["afk"]);
    const candidate = result.ok ? result.stdout.split("\n")[0]?.trim() ?? "" : "";
    return candidate.startsWith("/") ? { command: candidate, args: [] } : { command: "", args: [] };
  },
  exec: async (command, args, cwd) => {
    const result = await exec(command, args, cwd, undefined, { timeoutMs: 300_000, maxBuffer: 50_000_000 });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
  },
});
const workItemInventorySyncService = createWorkItemInventorySyncService({
  sync: () => workItemInventoryService.sync(),
});
const executionWorkspaceService = createExecutionWorkspaceService();
const workItemRunStore = createWorkItemRunStore({ resolveWorkspace });
const workItemRunHistoryService = createWorkItemRunHistoryService({ workspace: executionWorkspaceService, runStore: workItemRunStore });
const workItemExecutionService = createWorkItemExecutionService({
  getWorkItem: async (workItemId) => {
    const item = (await workItemInventoryService.list()).items.find(candidate => candidate.id === workItemId);
    if (!item) throw new Error(`工作项 ${workItemId} 不存在或当前账号无权访问`);
    return item;
  },
  resolveAfk: async () => {
    return resolveWorkItemCli({
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
      configuredCli: process.env.AFK_DESKTOP_CLI,
      exists: async file => access(file).then(() => true, () => false),
      which: async () => {
        const result = await exec("/usr/bin/which", ["afk"]);
        return result.ok ? result.stdout.split("\n")[0]?.trim() ?? "" : "";
      },
      help: async command => {
        const result = await exec(command, ["run", "--help"], undefined, undefined, { timeoutMs: 10_000 });
        return { ok: result.ok, stdout: result.stdout };
      },
    });
  },
  workspace: executionWorkspaceService,
  manifestStore: createWorkItemExecutionManifestStore(),
  runStore: workItemRunStore,
});
const backlogRunStore = createBacklogRunStore({ resolveWorkspace });
const backlogRuntimeService = createBacklogRuntimeService({
  resolveWorkspace,
  getBacklog: (workspace, id) => backlogService.show(workspace, id),
  runStore: backlogRunStore,
});
const workflowGraphService = new WorkflowGraphService();
const backlogExecutionService = createBacklogExecutionService({
  resolveAfk: async () => {
    const result = await exec("/usr/bin/which", ["afk"]);
    if (!result.ok) return "";
    const candidate = result.stdout.split("\n")[0]?.trim() ?? "";
    return candidate && candidate.startsWith("/") ? candidate : "";
  },
  resolveWorkspace,
  getBacklog: (workspace, id) => backlogService.show(workspace, id),
  getSummary: (workspace, id) => backlogRuntimeService.summary(workspace, id),
  validateTemplate: async (workspace, template) => (await workflowGraphService.generate({ workspace: resolveWorkspace(workspace), templateId: template, format: "json" })).status.state !== "rejected",
  invalidateBacklogList: backlogService.invalidateListCache,
  store: backlogRunStore,
  exec: async (command, args, cwd) => {
    const result = await exec(command, args, cwd);
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

export function registerIpcHandlers(deps: { jumpserverService?: unknown } = {}) {
  const jumpserverService = deps.jumpserverService ?? defaultJumpserverService;
  workItemInventorySyncService.start();
  if (typeof app.once === "function") app.once("before-quit", () => workItemInventorySyncService.stop());
  registerHandler(IPC_CHANNELS.copyText, (v: unknown) => v, (text) => clipboardService.copyText(text as string));
  registerHandler(IPC_CHANNELS.openExternal, (url: unknown) => {
    if (typeof url !== "string" || !url.trim()) throw new Error("外部地址无效");
    return url;
  }, (url) => externalUrlService.open(url));
  registerHandlerMulti(IPC_CHANNELS.workItemsList, [
    (v) => parseWorkItemInventoryOptions(v),
    (v) => { if (v !== undefined && typeof v !== "boolean") throw new Error("刷新参数无效"); return v as boolean | undefined; },
  ], ([options, forceRefresh]) => workItemInventoryService.list(options, forceRefresh === true).then(inventory => workItemRunHistoryService.merge(inventory)));
  registerHandler(IPC_CHANNELS.workItemsStart, parseWorkItemRunStartInput, (input) => workItemExecutionService.start(input));
  ipcMain.handle(IPC_CHANNELS.chooseWorkspace, async (event) => {
    assertTrustedSender(event);
    const selected = await dialog.showOpenDialog({ title: "选择 AFK 工作区", properties: ["openDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const workspace = await saveWorkspacePreference(app.getPath("userData"), selected.filePaths[0]);
    process.env.AFK_WORKSPACE = workspace;
    return workspace;
  });
  registerHandler(IPC_CHANNELS.snapshot, (v: unknown) => backlogWorkspace(v, "snapshot"), (workspace) => snapshot(workspace));
  registerHandler(IPC_CHANNELS.appearance, (v: unknown) => v, () => readAppearance());
  registerHandler(IPC_CHANNELS.appearanceSave, (v: unknown) => v, (appearance) => saveAppearance(appearance));
  registerHandlerMulti(IPC_CHANNELS.workflowSave, [
    (v) => backlogWorkspace(v, "workflowSave"),
    (v) => v,
  ], ([workspace, workflow]) => saveWorkflowConfig(workspace, workflow));
  registerHandlerMulti(IPC_CHANNELS.tmuxPane, [
    (v) => backlogWorkspace(v, "tmuxPane"),
    (v) => { if (typeof v !== "string" || !validSession(v)) throw new Error("tmux 会话名称无效"); return v; },
  ], async ([workspace, name]) => {
    const root = resolveWorkspace(workspace);
    if (!isAfkTmuxSession(root, name) || !(await listAfkTmux(root)).some((item) => item.name === name)) throw new Error("tmux 会话不是当前 AFK 工作区登记的资源，或已不存在");
    const result = await exec("tmux", ["capture-pane", "-p", "-t", name, "-S", "-160"]);
    if (!result.ok) throw new Error(result.stderr);
    return result.stdout;
  });
  registerHandlerMulti(IPC_CHANNELS.tmuxSend, [
    (v) => backlogWorkspace(v, "tmuxSend"),
    (v) => { if (typeof v !== "string" || !validSession(v)) throw new Error("tmux 会话名称无效"); return v; },
    (v) => { if (typeof v !== "string" || !v.trim() || v.length > 4_000 || v.includes("\0")) throw new Error("接管输入为空或超过安全长度"); return v; },
  ], async ([workspace, name, line]) => {
    const root = resolveWorkspace(workspace);
    if (!isAfkTmuxSession(root, name) || !(await listAfkTmux(root)).some((item) => item.name === name)) throw new Error("tmux 会话不是当前 AFK 工作区登记的资源，或已不存在");
    const result = await exec("tmux", ["send-keys", "-t", name, line, "Enter"]);
    if (!result.ok) throw new Error(result.stderr);
    return true;
  });
  registerHandler(IPC_CHANNELS.sshList, sshListOptions, (opts) => opts === undefined ? sshService.listHosts() : sshService.listHosts(opts));
  registerHandler(IPC_CHANNELS.sshAdd, validateSshHostInput, (input) => sshService.addHost(input));
  registerHandlerMulti(IPC_CHANNELS.sshUpdate, [validateSshHostId, validateSshHostInput], ([hostId, input]) => sshService.updateHost(hostId, input));
  registerHandler(IPC_CHANNELS.sshRemove, validateSshHostId, (id) => sshService.removeHost(id));
  registerHandler(IPC_CHANNELS.sshTrust, (v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("SSH 信任参数无效");
    const input = v as Record<string, unknown>;
    return { hostId: validateSshHostId(input.hostId), fingerprint: fingerprintInput(input.fingerprint) };
  }, (validated) => sshService.trustFingerprint(validated));
  registerHandler(IPC_CHANNELS.sshGenerateKey, (v: unknown) => v, () => sshService.generateKey());
  registerHandler(IPC_CHANNELS.sshDeployKey, validateSshHostId, (id) => sshService.deployKey(id));
  registerHandler(IPC_CHANNELS.sshTest, validateSshHostId, (id) => sshService.testHost(id));
  registerHandler(IPC_CHANNELS.sshUpload, validateSshHostId, async (id) => {
    const selection = await dialog.showOpenDialog({ title: "选择要上传的文件", properties: ["openFile"] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return sshService.uploadFile(id, selection.filePaths[0]);
  });
  registerHandler(IPC_CHANNELS.sshConnect, validateSshHostId, (id) => sshService.connect(id));
  registerHandlerMulti(IPC_CHANNELS.sshOpenExternal, [validateSshHostId, (v) => v === undefined ? "iterm2" : validateSshExternalTerminalId(v)], ([hostId, terminal]) => sshService.openExternal(hostId, terminal));
  registerHandler(IPC_CHANNELS.sshCredentialHas, validateSshHostId, (id) => sshService.hasCredential(id));
  registerHandler(IPC_CHANNELS.sshCredentialSet, sshCredentialSetInput, (validated) => sshService.setCredential(validated.hostId, validated.password));
  registerHandler(IPC_CHANNELS.sshCredentialRemove, validateSshHostId, (id) => sshService.removeCredential(id));
  registerHandler(IPC_CHANNELS.sshInput, (v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("SSH 输入参数无效");
    const input = v as Record<string, unknown>;
    if (typeof input.data !== "string") throw new Error("SSH 输入参数无效");
    return { sessionId: validateSshSessionId(input.sessionId), data: input.data };
  }, (validated) => sshService.input(validated.sessionId, validated.data));
  registerHandler(IPC_CHANNELS.sshResize, (v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("SSH 尺寸参数无效");
    const input = v as Record<string, unknown>;
    const size = validateSshResize(input.cols, input.rows);
    return { sessionId: validateSshSessionId(input.sessionId), size };
  }, (validated) => sshService.resize(validated.sessionId, validated.size.cols, validated.size.rows));
  registerHandler(IPC_CHANNELS.sshClose, validateSshSessionId, (sessionId) => sshService.close(sessionId));

  registerHandler(IPC_CHANNELS.jumpserverTestConnection, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 测试连接参数无效");
    const obj = v as Record<string, unknown>;
    if (typeof obj.hostname !== "string" || !obj.hostname) throw new Error("堡垒机地址无效");
    if (typeof obj.port !== "number" || obj.port < 1 || obj.port > 65535) throw new Error("堡垒机端口无效");
    if (typeof obj.user !== "string" || !obj.user) throw new Error("堡垒机用户无效");
    if (typeof obj.password !== "string" || !obj.password) throw new Error("堡垒机密码无效");
    return { hostname: obj.hostname, port: obj.port, user: obj.user, password: obj.password, otpSecret: typeof obj.otpSecret === "string" ? obj.otpSecret : undefined };
  }, (input) => (jumpserverService as { testConnection: (input: unknown) => unknown }).testConnection(input));
  registerHandler(IPC_CHANNELS.jumpserverAddBastion, validateJumpserverBastionInput, (input) => (jumpserverService as { addBastion: (input: unknown) => unknown }).addBastion(input));
  registerHandler(IPC_CHANNELS.jumpserverListAssets, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 资产列表参数无效");
    const obj = v as Record<string, unknown>;
    return validateJumpserverBastionId(obj.bastionId);
  }, (bastionId) => (jumpserverService as { listAssets: (bastionId: string) => unknown }).listAssets(bastionId));
  registerHandler(IPC_CHANNELS.jumpserverPreviewAssets, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 资产预览参数无效");
    const obj = v as Record<string, unknown>;
    if (typeof obj.hostname !== "string" || !obj.hostname) throw new Error("堡垒机地址无效");
    if (typeof obj.port !== "number" || obj.port < 1 || obj.port > 65535) throw new Error("堡垒机端口无效");
    if (typeof obj.user !== "string" || !obj.user) throw new Error("堡垒机用户无效");
    if (typeof obj.password !== "string" || !obj.password) throw new Error("堡垒机密码无效");
    return { hostname: obj.hostname, port: obj.port, user: obj.user, password: obj.password, otpSecret: typeof obj.otpSecret === "string" ? obj.otpSecret : undefined };
  }, (input) => (jumpserverService as { previewAssets: (input: unknown) => unknown }).previewAssets(input));
  registerHandler(IPC_CHANNELS.jumpserverSyncAssets, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 资产同步参数无效");
    const obj = v as Record<string, unknown>;
    return { bastionId: validateJumpserverBastionId(obj.bastionId), opts: validateJumpserverSyncOptions(obj) };
  }, (validated) => (jumpserverService as { syncAssets: (bastionId: string, opts: unknown) => unknown }).syncAssets(validated.bastionId, validated.opts));
  registerHandler(IPC_CHANNELS.jumpserverRemoveBastion, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 移除堡垒机参数无效");
    const obj = v as Record<string, unknown>;
    return validateJumpserverBastionId(obj.bastionId);
  }, (bastionId) => (jumpserverService as { removeBastion: (bastionId: string) => unknown }).removeBastion(bastionId));
  registerHandler(IPC_CHANNELS.jumpserverListBastions, (v: unknown) => v, () => (jumpserverService as { listBastions: () => unknown }).listBastions());
  registerHandler(IPC_CHANNELS.jumpserverGetSyncLog, (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JumpServer 同步日志参数无效");
    const obj = v as Record<string, unknown>;
    return validateJumpserverBastionId(obj.bastionId);
  }, (bastionId) => (jumpserverService as { getSyncLog: (bastionId: string) => unknown }).getSyncLog(bastionId));

  registerHandlerMulti(IPC_CHANNELS.graphStatus, [
    (v) => validateWorkflowGraphWorkspace(v),
    (v) => validateWorkflowGraphTemplateId(v),
  ], ([workspace, templateId]) => workflowGraphService.status(workspace, templateId));
  registerHandler(IPC_CHANNELS.graphGenerate, parseWorkflowGraphGenerateRequest, (request) => workflowGraphService.generate(request));

  registerHandlerMulti(IPC_CHANNELS.backlogList, [
    (v) => backlogWorkspace(v, "backlog.list"),
    (v) => parseBacklogListOptions(v),
  ], ([workspace, options]) => backlogService.list(workspace, options));
  registerHandlerMulti(IPC_CHANNELS.backlogShow, [
    (v) => backlogWorkspace(v, "backlog.show"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.show: id 必须是字符串"); return v; },
  ], ([workspace, id]) => backlogService.show(workspace, id));
  registerHandlerMulti(IPC_CHANNELS.backlogCreate, [
    (v) => backlogWorkspace(v, "backlog.create"),
    parseBacklogCreateInput,
  ], ([workspace, input]) => backlogService.create(workspace, input));
  registerHandlerMulti(IPC_CHANNELS.backlogStart, [
    (v) => backlogWorkspace(v, "backlog.start"),
    parseBacklogRunStartInput,
  ], ([workspace, input]) => backlogExecutionService.start(workspace, input));
  registerHandlerMulti(IPC_CHANNELS.backlogStop, [
    (v) => backlogWorkspace(v, "backlog.stop"),
    parseBacklogId,
  ], ([workspace, backlogId]) => backlogExecutionService.stop(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogRecover, [
    (v) => backlogWorkspace(v, "backlog.recover"),
    parseBacklogId,
  ], ([workspace, backlogId]) => backlogExecutionService.recover(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogRetry, [
    (v) => backlogWorkspace(v, "backlog.retry"),
    parseBacklogRunRetryInput,
  ], ([workspace, input]) => backlogExecutionService.retry(workspace, input));
  registerHandlerMulti(IPC_CHANNELS.backlogConfirmMerge, [
    (v) => backlogWorkspace(v, "backlog.confirmMerge"),
    parseBacklogId,
  ], ([workspace, backlogId]) => backlogExecutionService.confirmMerge(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogRuns, [
    (v) => backlogWorkspace(v, "backlog.runs"),
    (v) => { if (v !== undefined && (typeof v !== "string" || !v)) throw new Error("backlog.runs: backlogId 必须是字符串"); return v as string | undefined; },
  ], ([workspace, backlogId]) => backlogExecutionService.list(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogSummary, [
    (v) => backlogWorkspace(v, "backlog.summary"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.summary: backlogId 必须是字符串"); return v; },
  ], ([workspace, backlogId]) => backlogRuntimeService.summary(workspace, backlogId));
  registerHandlerMulti(IPC_CHANNELS.backlogTagAdd, [
    (v) => backlogWorkspace(v, "backlog.tag.add"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.add: id 必须是字符串"); return v; },
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.add: tag 必须是字符串"); return v; },
  ], ([workspace, id, tag]) => backlogService.addTag(workspace, id, tag));
  registerHandlerMulti(IPC_CHANNELS.backlogTagRemove, [
    (v) => backlogWorkspace(v, "backlog.tag.remove"),
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.remove: id 必须是字符串"); return v; },
    (v) => { if (typeof v !== "string" || !v) throw new Error("backlog.tag.remove: tag 必须是字符串"); return v; },
  ], ([workspace, id, tag]) => backlogService.removeTag(workspace, id, tag));
}
