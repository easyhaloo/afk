"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("afkDesktop", {
    chooseWorkspace: () => electron_1.ipcRenderer.invoke("afk:choose-workspace"),
    snapshot: (workspace) => electron_1.ipcRenderer.invoke("afk:snapshot", workspace),
    tmuxPane: (session) => electron_1.ipcRenderer.invoke("afk:tmux-pane", session),
    tmuxSend: (session, line) => electron_1.ipcRenderer.invoke("afk:tmux-send", session, line),
});
