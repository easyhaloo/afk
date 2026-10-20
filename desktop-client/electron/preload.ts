/**
 * The renderer's only bridge into the main process.
 *
 * The wire names come from the shared contract's single table: the preload
 * has no channel literal of its own, so the table cannot drift away from
 * the channels the main process registers. The source is an ES module
 * because the shared contract is one; the artifact is still CommonJS,
 * because `scripts/build-main.mjs` bundles this file with esbuild's
 * `format: 'cjs'` — sandboxed preloads must be CommonJS.
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type DesktopApi } from "../shared/ipc-contract.js";

const api: DesktopApi = {
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
    runs: (workspace, backlogId) => backlogId === undefined
      ? ipcRenderer.invoke(IPC_CHANNELS.backlogRuns, workspace)
      : ipcRenderer.invoke(IPC_CHANNELS.backlogRuns, workspace, backlogId),
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
