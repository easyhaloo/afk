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

  // E2E runs on the developer's own machine, where a visible window steals
  // focus from whatever else they are doing. The window is still created and
  // still paints, so the test exercises the same preload + IPC path as
  // production. The test entry sets this before importing the main bundle.
  const hiddenForTest = process.env.AFK_E2E_NO_WINDOW === "1";

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 640,
    title: "AFK Control",
    backgroundColor: "#f7f7fa",
    icon: iconPath,
    show: !hiddenForTest,
    webPreferences: {
      // Built as preload.cjs on purpose: Electron requires sandboxed preloads
      // to be CommonJS, so it must not follow the package's ESM type.
      preload: path.join(appRoot, "dist-electron/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // A window that is never on screen is treated as background, which
      // throttles timers and requestAnimationFrame. Leave the production
      // default untouched.
      ...(hiddenForTest ? { backgroundThrottling: false } : {}),
    },
  });
  installNavigationGuard(window.webContents);
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(appRoot, "dist/index.html"));
  return window;
}
