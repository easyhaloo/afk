import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/ipc-contract";

// Sandboxed preloads can only require Electron built-ins. Keep the wire names
// local while the shared contract remains the source of renderer/main types.
const IPC_CHANNELS = {
  chooseWorkspace: "afk:choose-workspace",
  snapshot: "afk:snapshot",
  appearance: "afk:appearance",
  appearanceSave: "afk:appearance-save",
  workflowSave: "afk:workflow-save",
  tmuxPane: "afk:tmux-pane",
  tmuxSend: "afk:tmux-send",
  sshList: "afk:ssh-list",
  sshAdd: "afk:ssh-add",
  sshRemove: "afk:ssh-remove",
  sshTrust: "afk:ssh-trust",
  sshGenerateKey: "afk:ssh-generate-key",
  sshDeployKey: "afk:ssh-deploy-key",
  sshTest: "afk:ssh-test",
  sshConnect: "afk:ssh-connect",
  sshInput: "afk:ssh-input",
  sshResize: "afk:ssh-resize",
  sshClose: "afk:ssh-close",
  sshData: "afk:ssh-data",
  sshExit: "afk:ssh-exit",
} as const;

const api: DesktopApi = {
  chooseWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspace),
  snapshot: (workspace) => ipcRenderer.invoke(IPC_CHANNELS.snapshot, workspace),
  appearance: () => ipcRenderer.invoke(IPC_CHANNELS.appearance),
  saveAppearance: (appearance) => ipcRenderer.invoke(IPC_CHANNELS.appearanceSave, appearance),
  saveWorkflow: (workspace, workflow) => ipcRenderer.invoke(IPC_CHANNELS.workflowSave, workspace, workflow),
  tmuxPane: (workspace, session) => ipcRenderer.invoke(IPC_CHANNELS.tmuxPane, workspace, session),
  tmuxSend: (workspace, session, line) => ipcRenderer.invoke(IPC_CHANNELS.tmuxSend, workspace, session, line),
  ssh: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.sshList),
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.sshAdd, input),
    remove: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshRemove, hostId),
    trust: (request) => ipcRenderer.invoke(IPC_CHANNELS.sshTrust, request),
    generateKey: () => ipcRenderer.invoke(IPC_CHANNELS.sshGenerateKey),
    deployKey: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshDeployKey, hostId),
    test: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshTest, hostId),
    connect: (hostId) => ipcRenderer.invoke(IPC_CHANNELS.sshConnect, hostId),
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
};

contextBridge.exposeInMainWorld("afkDesktop", api);
