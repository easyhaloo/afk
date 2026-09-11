import { app, BrowserWindow } from "electron";
import path from "node:path";
import { installNavigationGuard } from "../security/navigation-guard";

export async function createMainWindow() {
  const iconPath = path.join(app.getAppPath(), "assets/afk-control.png");
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 640,
    title: "AFK Control",
    backgroundColor: "#f7f7fa",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installNavigationGuard(window.webContents);
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(__dirname, "../../../dist/index.html"));
  return window;
}
