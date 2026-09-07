import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/ipc-contract";

// Sandboxed preloads can only require Electron built-ins. Keep the wire names
// local while the shared contract remains the source of renderer/main types.
const IPC_CHANNELS = {
  copyText: "afk:copy-text",
  chooseWorkspace: "afk:choose-workspace",
  snapshot: "afk:snapshot",
  appearance: "afk:appearance",
  appearanceSave: "afk:appearance-save",
  workflowSave: "afk:workflow-save",
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
  backlogTagAdd: "afk:backlog-tag-add",
  backlogTagRemove: "afk:backlog-tag-remove",
} as const;

const api: DesktopApi = {
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  chooseWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspace),
  snapshot: (workspace) => ipcRenderer.invoke(IPC_CHANNELS.snapshot, workspace),
  appearance: () => ipcRenderer.invoke(IPC_CHANNELS.appearance),
  saveAppearance: (appearance) => ipcRenderer.invoke(IPC_CHANNELS.appearanceSave, appearance),
  saveWorkflow: (workspace, workflow) => ipcRenderer.invoke(IPC_CHANNELS.workflowSave, workspace, workflow),
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
    addTag: (workspace, id, tag) => ipcRenderer.invoke(IPC_CHANNELS.backlogTagAdd, workspace, id, tag),
    removeTag: (workspace, id, tag) => ipcRenderer.invoke(IPC_CHANNELS.backlogTagRemove, workspace, id, tag),
  },
};

contextBridge.exposeInMainWorld("afkDesktop", api);
