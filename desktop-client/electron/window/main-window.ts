import { app, BrowserWindow } from "electron";
import path from "node:path";
import { installNavigationGuard } from "../security/navigation-guard.js";

export async function createMainWindow() {
  // Resolve artifact paths from the app root rather than from this module's own
  // location: main.js is a bundle, so module-relative depth is not a meaningful
  // way to locate the preload or the renderer. getAppPath() returns the app dir
  // in dev and the asar root when packaged, so one expression covers both.
  const appRoot = app.getAppPath();

  const iconPath = path.join(appRoot, "assets/afk-control.png");
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
      // Built as preload.cjs on purpose: Electron requires sandboxed preloads
      // to be CommonJS, so it must not follow the package's ESM type.
      preload: path.join(appRoot, "dist-electron/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  installNavigationGuard(window.webContents);
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(appRoot, "dist/index.html"));
  return window;
}
