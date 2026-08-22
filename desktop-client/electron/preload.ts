import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("afkDesktop", {
  chooseWorkspace: () => ipcRenderer.invoke("afk:choose-workspace"),
  snapshot: (workspace: string) => ipcRenderer.invoke("afk:snapshot", workspace),
  tmuxPane: (session: string) => ipcRenderer.invoke("afk:tmux-pane", session),
  tmuxSend: (session: string, line: string) => ipcRenderer.invoke("afk:tmux-send", session, line),
});
