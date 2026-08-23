import { contextBridge, ipcRenderer } from "electron";
const GRAPH_IPC_CHANNELS = { status: "afk:graph:status", generate: "afk:graph:generate", export: "afk:graph:export" } as const;
type WorkflowGraphRequest = { workspace: string; templateId: string; format?: "json" | "archify-json" };

contextBridge.exposeInMainWorld("afkDesktop", {
  chooseWorkspace: () => ipcRenderer.invoke("afk:choose-workspace"),
  snapshot: (workspace: string) => ipcRenderer.invoke("afk:snapshot", workspace),
  tmuxPane: (session: string) => ipcRenderer.invoke("afk:tmux-pane", session),
  tmuxSend: (session: string, line: string) => ipcRenderer.invoke("afk:tmux-send", session, line),
  graphStatus: (workspace: string, templateId: string) => ipcRenderer.invoke(GRAPH_IPC_CHANNELS.status, workspace, templateId),
  graphGenerate: (request: WorkflowGraphRequest) => ipcRenderer.invoke(GRAPH_IPC_CHANNELS.generate, request),
  graphExport: (request: WorkflowGraphRequest) => ipcRenderer.invoke(GRAPH_IPC_CHANNELS.export, request),
});
