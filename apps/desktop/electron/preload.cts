import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/ipc-contract.js";

// Sandboxed preloads can only require Electron built-ins. Keep the wire names
// local while the shared contract remains the source of renderer/main types.
const IPC_CHANNELS = {
  updateStatus: "afk:update-status",
  updateGetStatus: "afk:update-get-status",
  updateCheck: "afk:update-check",
  updateDownload: "afk:update-download",
  updateInstall: "afk:update-install",
  copyText: "afk:copy-text",
  openExternal: "afk:open-external",
  chooseWorkspace: "afk:choose-workspace",
  snapshot: "afk:snapshot",
  appearance: "afk:appearance",
  appearanceSave: "afk:appearance-save",
  workflowSave: "afk:workflow-save",
  graphStatus: "afk:graph-status",
  graphGenerate: "afk:graph-generate",
  tmuxPane: "afk:tmux-pane",
  tmuxSend: "afk:tmux-send",
  sshList: "afk:ssh-list",
  sshAdd: "afk:ssh-add",
  sshUpdate: "afk:ssh-update",
  sshRemove: "afk:ssh-remove",
  sshTrust: "afk:ssh-trust",
  sshGenerateKey: "afk:ssh-generate-key",
  sshDeployKey: "afk:ssh-deploy-key",
  sshTest: "afk:ssh-test",
  sshUpload: "afk:ssh-upload",
  sshConnect: "afk:ssh-connect",
  sshOpenExternal: "afk:ssh-open-external",
  sshCredentialHas: "afk:ssh-credential-has",
  sshCredentialSet: "afk:ssh-credential-set",
  sshCredentialRemove: "afk:ssh-credential-remove",
  sshInput: "afk:ssh-input",
  sshResize: "afk:ssh-resize",
  sshClose: "afk:ssh-close",
  sshData: "afk:ssh-data",
  sshExit: "afk:ssh-exit",
  backlogList: "afk:backlog-list",
  backlogShow: "afk:backlog-show",
  backlogCreate: "afk:backlog-create",
  backlogStop: "afk:backlog-stop",
  backlogRecover: "afk:backlog-recover",
  backlogConfirmMerge: "afk:backlog-confirm-merge",
  backlogTagAdd: "afk:backlog-tag-add",
  backlogTagRemove: "afk:backlog-tag-remove",
  backlogSummary: "afk:backlog-summary",
  workItemsList: "afk:work-items-list",
  workItemsStart: "afk:work-items-start",
  workItemsExecutions: "afk:work-items-executions",
  workItemsExecutionRunDetail: "afk:work-items-execution-run-detail",
  workItemsResolveAttachTarget: "afk:work-items-resolve-attach-target",
  workItemsAttach: "afk:work-items-attach",
  workItemsAttachInput: "afk:work-items-attach-input",
  workItemsAttachResize: "afk:work-items-attach-resize",
  workItemsDetach: "afk:work-items-detach",
  workItemsAttachData: "afk:work-items-attach-data",
  workItemsAttachExit: "afk:work-items-attach-exit",
  jumpserverTestConnection: "afk:jumpserver-test-connection",
  jumpserverAddBastion: "afk:jumpserver-add-bastion",
  jumpserverListAssets: "afk:jumpserver-list-assets",
  jumpserverPreviewAssets: "afk:jumpserver-preview-assets",
  jumpserverSyncAssets: "afk:jumpserver-sync-assets",
  jumpserverRemoveBastion: "afk:jumpserver-remove-bastion",
  jumpserverListBastions: "afk:jumpserver-list-bastions",
  jumpserverGetSyncLog: "afk:jumpserver-get-sync-log",
} as const;

const api: DesktopApi = {
  update: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetStatus), check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck), download: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload), install: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
    onStatus: listener => { const handler = (_event: Electron.IpcRendererEvent, status: import('../shared/ipc-contract.js').DesktopUpdateStatus) => listener(status); ipcRenderer.on(IPC_CHANNELS.updateStatus, handler); return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStatus, handler); },
  },
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  chooseWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspace),
  snapshot: (workspace) => ipcRenderer.invoke(IPC_CHANNELS.snapshot, workspace),
  appearance: () => ipcRenderer.invoke(IPC_CHANNELS.appearance),
  saveAppearance: (appearance) => ipcRenderer.invoke(IPC_CHANNELS.appearanceSave, appearance),
  saveWorkflow: (workspace, workflow) => ipcRenderer.invoke(IPC_CHANNELS.workflowSave, workspace, workflow),
  graphStatus: (workspace, templateId) => ipcRenderer.invoke(IPC_CHANNELS.graphStatus, workspace, templateId),
  graphGenerate: (request) => ipcRenderer.invoke(IPC_CHANNELS.graphGenerate, request),
  tmuxPane: (workspace, session) => ipcRenderer.invoke(IPC_CHANNELS.tmuxPane, workspace, session),
  tmuxSend: (workspace, session, line) => ipcRenderer.invoke(IPC_CHANNELS.tmuxSend, workspace, session, line),
  ssh: {
    list: (options) => options === undefined ? ipcRenderer.invoke(IPC_CHANNELS.sshList) : ipcRenderer.invoke(IPC_CHANNELS.sshList, options),
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.sshAdd, input),
    update: (hostId, input) => ipcRenderer.invoke(IPC_CHANNELS.sshUpdate, hostId, input),
    remove: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshRemove, hostId),
    trust: (request) => ipcRenderer.invoke(IPC_CHANNELS.sshTrust, request),
    generateKey: () => ipcRenderer.invoke(IPC_CHANNELS.sshGenerateKey),
    deployKey: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshDeployKey, hostId),
    test: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshTest, hostId),
    upload: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshUpload, hostId),
    connect: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshConnect, hostId),
    openExternal: (hostId, terminal) => terminal ? ipcRenderer.invoke(IPC_CHANNELS.sshOpenExternal, hostId, terminal) : ipcRenderer.invoke(IPC_CHANNELS.sshOpenExternal, hostId),
    credentialHas: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshCredentialHas, hostId),
    credentialSet: (input) => ipcRenderer.invoke(IPC_CHANNELS.sshCredentialSet, input),
    credentialRemove: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshCredentialRemove, hostId),
    input: (request) => ipcRenderer.invoke(IPC_CHANNELS.sshInput, request),
    resize: (request) => ipcRenderer.invoke(IPC_CHANNELS.sshResize, request),
    close: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sshClose, sessionId),
    onData: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => listener(sessionId, data);
      ipcRenderer.on(IPC_CHANNELS.sshData, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.sshData, handler);
    },
    onExit: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, code: number) => listener(sessionId, code);
      ipcRenderer.on(IPC_CHANNELS.sshExit, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.sshExit, handler);
    },
  },
  backlog: {
    list: (workspace, options) => options === undefined
      ? ipcRenderer.invoke(IPC_CHANNELS.backlogList, workspace)
      : ipcRenderer.invoke(IPC_CHANNELS.backlogList, workspace, options),
    show: (workspace, id) => ipcRenderer.invoke(IPC_CHANNELS.backlogShow, workspace, id),
    create: (workspace, input) => ipcRenderer.invoke(IPC_CHANNELS.backlogCreate, workspace, input),
    stop: (workspace, backlogId) => ipcRenderer.invoke(IPC_CHANNELS.backlogStop, workspace, backlogId),
    recover: (workspace, backlogId) => ipcRenderer.invoke(IPC_CHANNELS.backlogRecover, workspace, backlogId),
    confirmMerge: (workspace, backlogId) => ipcRenderer.invoke(IPC_CHANNELS.backlogConfirmMerge, workspace, backlogId),
    summary: (workspace, backlogId) => ipcRenderer.invoke(IPC_CHANNELS.backlogSummary, workspace, backlogId),
    addTag: (workspace, id, tag) => ipcRenderer.invoke(IPC_CHANNELS.backlogTagAdd, workspace, id, tag),
    removeTag: (workspace, id, tag) => ipcRenderer.invoke(IPC_CHANNELS.backlogTagRemove, workspace, id, tag),
  },
  workItems: {
    list: (options, forceRefresh) => forceRefresh
      ? ipcRenderer.invoke(IPC_CHANNELS.workItemsList, options, true)
      : options === undefined
        ? ipcRenderer.invoke(IPC_CHANNELS.workItemsList)
        : ipcRenderer.invoke(IPC_CHANNELS.workItemsList, options),
    start: (input) => ipcRenderer.invoke(IPC_CHANNELS.workItemsStart, input),
    executions: (options) => ipcRenderer.invoke(IPC_CHANNELS.workItemsExecutions, options),
    executionRunDetail: (runId, workItemId) => ipcRenderer.invoke(IPC_CHANNELS.workItemsExecutionRunDetail, runId, workItemId),
    resolveAttachTarget: (request) => ipcRenderer.invoke(IPC_CHANNELS.workItemsResolveAttachTarget, request),
    attach: (input) => ipcRenderer.invoke(IPC_CHANNELS.workItemsAttach, input),
    attachInput: (attachId, data) => ipcRenderer.invoke(IPC_CHANNELS.workItemsAttachInput, attachId, data),
    attachResize: (attachId, cols, rows) => ipcRenderer.invoke(IPC_CHANNELS.workItemsAttachResize, attachId, cols, rows),
    detach: (attachId) => ipcRenderer.invoke(IPC_CHANNELS.workItemsDetach, attachId),
    onAttachData: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, attachId: string, data: string) => listener(attachId, data);
      ipcRenderer.on(IPC_CHANNELS.workItemsAttachData, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.workItemsAttachData, handler);
    },
    onAttachExit: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, attachId: string, code: number) => listener(attachId, code);
      ipcRenderer.on(IPC_CHANNELS.workItemsAttachExit, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.workItemsAttachExit, handler);
    },
  },
  jumpserver: {
    testConnection: (input) => ipcRenderer.invoke(IPC_CHANNELS.jumpserverTestConnection, input),
    addBastion: (input) => ipcRenderer.invoke(IPC_CHANNELS.jumpserverAddBastion, input),
    listAssets: (bastionId) => ipcRenderer.invoke(IPC_CHANNELS.jumpserverListAssets, { bastionId }),
    previewAssets: (input) => ipcRenderer.invoke(IPC_CHANNELS.jumpserverPreviewAssets, input),
    syncAssets: (input) => ipcRenderer.invoke(IPC_CHANNELS.jumpserverSyncAssets, input),
    removeBastion: (bastionId) => ipcRenderer.invoke(IPC_CHANNELS.jumpserverRemoveBastion, { bastionId }),
    listBastions: () => ipcRenderer.invoke(IPC_CHANNELS.jumpserverListBastions),
    getSyncLog: (bastionId) => ipcRenderer.invoke(IPC_CHANNELS.jumpserverGetSyncLog, { bastionId }),
  },
};

contextBridge.exposeInMainWorld("afkDesktop", api);
