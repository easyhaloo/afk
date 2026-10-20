import { app, clipboard, safeStorage, shell } from "electron";
import { homedir } from "node:os";
import path from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-contract.js";
import { exec } from "../adapters/process-executor.js";
import { createKnownHostsAdapter } from "../adapters/known-hosts-adapter.js";
import { createSshCommandAdapter } from "../adapters/ssh-command-adapter.js";
import { createSshConfigAdapter } from "../adapters/ssh-config-adapter.js";
import { createSshManagedHostStore } from "../adapters/ssh-managed-host-store.js";
import { createSshPtyAdapter } from "../adapters/ssh-pty-adapter.js";
import { createExternalTerminalAdapter } from "../adapters/external-terminal-adapter.js";
import { listRunResources } from "../adapters/resource-adapter.js";
import { createTmuxAttachPtyAdapter } from "../adapters/tmux-pty-adapter.js";
import { createExecutionAttachService } from "../services/execution-attach-service.js";
import { createExecutionRuntimeAdapter } from "../adapters/execution-runtime-adapter.js";
import { createRunEventQueryAdapter } from "../adapters/run-event-query-adapter.js";
import { readAppearance, saveAppearance } from "../services/appearance-service.js";
import { createBacklogService } from "../services/backlog-service.js";
import { backlogProviders, executeWorkItem, providerBundle, workflowTargetBranch } from "../composition-root.js";
import { createBacklogExecutionService } from "../services/backlog-execution-service.js";
import { createBacklogRunStore } from "../services/backlog-run-store.js";
import { createBacklogRuntimeService } from "../services/backlog-runtime-service.js";
import { createClipboardService } from "../services/clipboard-service.js";
import { createSshCredentialService } from "../services/ssh-credential-service.js";
import { createJumpserverService } from "../services/jumpserver-service.js";
import { createJumpserverCredentialService } from "../services/jumpserver-credential-service.js";
import { createSshService } from "../services/ssh-service.js";
import { createExternalUrlService } from "../services/external-url-service.js";
import { createProviderWorkItemApplicationFacade, createWorkItemApplicationAdapter } from "../adapters/work-item-application-adapter.js";
import { createWorkItemInventoryService } from "../services/work-item-inventory-service.js";
import { createWorkItemInventoryStore } from "../services/work-item-inventory-store.js";
import { createWorkItemInventorySyncService } from "../services/work-item-inventory-sync-service.js";
import { createWorkItemExecutionService } from "../services/work-item-execution-service.js";
import { createWorkItemExecutionQueryService } from "../services/work-item-execution-query-service.js";
import { createWorkItemExecutionManifestStore } from "../services/work-item-execution-manifest-store.js";
import { createWorkItemRunStore } from "../services/work-item-run-store.js";
import { createWorkItemRunHistoryService } from "../services/work-item-run-history-service.js";
import { createExecutionWorkspaceService } from "../services/execution-workspace-service.js";
import { WorkflowGraphService } from "../services/graph-service.js";
import { resolveWorkspace } from "../services/workspace-service.js";
import { detectAgentRuntimes } from "../services/runtime-service.js";
import { broadcast } from "./handler-registry.js";

/**
 * The services the IPC layer serves.
 *
 * They are assembled once, here, and the channels import the ones they use.
 * A channel module that built its own service would be a second copy of the
 * desktop's wiring.
 */
const home = homedir();
const sshManagedHostStore = createSshManagedHostStore({ file: path.join(app.getPath("userData"), "ssh-hosts.yml") });
const clipboardService = createClipboardService({ writeText: (text) => clipboard.writeText(text) });
const externalUrlService = createExternalUrlService({ openExternal: (url) => shell.openExternal(url) });
const sshCredentialService = createSshCredentialService({ home, safeStorage });
export type JumpserverService = ReturnType<typeof createJumpserverService>;

const defaultJumpserverService = createJumpserverService({
  home,
  credentialService: createJumpserverCredentialService({ home, safeStorage }),
  managedHostStore: sshManagedHostStore,
  listManagedHosts: async () => ({ hosts: await sshManagedHostStore.list() }),
});
const externalTerminal = createExternalTerminalAdapter();
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
  externalTerminal,
  pty: createSshPtyAdapter({ onData: (sessionId, data) => broadcast(IPC_CHANNELS.sshData, sessionId, data), onExit: (sessionId, code) => broadcast(IPC_CHANNELS.sshExit, sessionId, code) }),
});
const backlogService = createBacklogService({
  providers: (workspace, platform) => backlogProviders(workspace, platform),
  resolveWorkspace,
});
const workItemInventoryService = createWorkItemInventoryService({
  application: createWorkItemApplicationAdapter(createProviderWorkItemApplicationFacade()),
  store: createWorkItemInventoryStore(path.join(app.getPath("userData"), "work-item-inventory.json")),
});
const tmuxAttachPty = createTmuxAttachPtyAdapter({
  onData: (attachId, data) => broadcast(IPC_CHANNELS.workItemsAttachData, attachId, data),
  onExit: (attachId, code) => broadcast(IPC_CHANNELS.workItemsAttachExit, attachId, code),
});
const executionAttachService = createExecutionAttachService({
  readRunResources: listRunResources,
  verifyTargetExists: async (target) => (await exec("tmux", ["has-session", "-t", target])).ok,
});
const workItemInventorySyncService = createWorkItemInventorySyncService({
  sync: () => workItemInventoryService.sync(),
});
const executionWorkspaceService = createExecutionWorkspaceService();
const workItemRunStore = createWorkItemRunStore({ resolveWorkspace });
const workItemExecutionQueryService = createWorkItemExecutionQueryService(createRunEventQueryAdapter(), createExecutionRuntimeAdapter({
  readReceipt: async (runId, workItemId) => {
    const metadata = await executionWorkspaceService.read(workItemId);
    if (!metadata || metadata.taskId !== workItemId) return undefined;
    return (await workItemRunStore.load(metadata.root)).find(run => run.id === runId && run.workspacePath === metadata.root);
  },
}));
const workItemRunHistoryService = createWorkItemRunHistoryService({ workspace: executionWorkspaceService, runStore: workItemRunStore });
const workItemExecutionService = createWorkItemExecutionService({
  getWorkItem: async (workItemId) => {
    const item = (await workItemInventoryService.list()).items.find(candidate => candidate.id === workItemId);
    if (!item) throw new Error(`工作项 ${workItemId} 不存在或当前账号无权访问`);
    return item;
  },
  execute: async input => executeWorkItem()(input),
  resolveAgent: async (id) => {
    const runtime = (await detectAgentRuntimes()).find(candidate => candidate.id === id && candidate.available);
    return runtime ? { id: runtime.id, label: runtime.label, command: runtime.command, executable: runtime.executable } : undefined;
  },
  openTerminalCommand: (command, terminal) => externalTerminal.openCommand(command, terminal),
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
  resolveWorkspace,
  providers: async (workspace: string) => {
    const bundle = await providerBundle(workspace);
    return { backlog: bundle.backlog, changes: bundle.changes };
  },
  targetBranch: (workspace: string) => workflowTargetBranch(workspace),
  getSummary: (workspace, id) => backlogRuntimeService.summary(workspace, id),
  invalidateBacklogList: backlogService.invalidateListCache,
  store: backlogRunStore,
});

export {
  backlogService,
  backlogExecutionService,
  backlogRuntimeService,
  clipboardService,
  defaultJumpserverService,
  executionAttachService,
  externalUrlService,
  sshService,
  tmuxAttachPty,
  workflowGraphService,
  workItemExecutionQueryService,
  workItemExecutionService,
  workItemInventoryService,
  workItemInventorySyncService,
  workItemRunHistoryService,
};
