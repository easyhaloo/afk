import { app, BrowserWindow } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { registerIpcHandlers } from "./ipc/register-handlers.js";
import { registerUpdateService } from "./services/update-service.js";
import { readWorkspacePreference } from "./services/workspace-preference-service.js";
import { createMainWindow } from "./window/main-window.js";
import { workspaceStateDirectory } from "@afk/runtime/infrastructure/workspace";

/** Electron bootstrap: lifecycle and module composition only. */
const readyFile = !app.isPackaged ? process.env.AFK_CONTROL_READY_FILE : undefined;
const userData = readyFile ? path.join(path.dirname(readyFile), "user-data") : path.join(workspaceStateDirectory(), "desktop");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    const workspace = await readWorkspacePreference(app.getPath("userData"));
    if (workspace) process.env.AFK_WORKSPACE = workspace;
    registerIpcHandlers();
    registerUpdateService();
    await createMainWindow();
    if (readyFile) writeFileSync(readyFile, String(process.pid));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
