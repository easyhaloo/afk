import { app, BrowserWindow } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc/register-handlers";
import { readWorkspacePreference } from "./services/workspace-preference-service";
import { createMainWindow } from "./window/main-window";

/** Electron bootstrap: lifecycle and module composition only. */
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
    await createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
