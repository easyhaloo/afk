const { app, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");

// E2E must not pop a window on the developer's screen or steal focus from
// their real work. CI deliberately keeps the window visible: Xvfb already
// provides a display there, and the suite should exercise the same
// visible-window path users get rather than a test-only configuration.
// main-window.ts reads this before it constructs the BrowserWindow, so it
// must be set before the real main.js is imported below.
const hideForTest = process.env.CI ? "0" : "1";
process.env.AFK_E2E_NO_WINDOW = hideForTest;

// Registered before main.js is imported, so this runs ahead of the main
// process's own whenReady handler. macOS only — a no-op elsewhere.
if (hideForTest === "1") app.whenReady().then(() => app.dock?.hide());

// Native dialogs are not BrowserWindows, so show:false never reaches them:
// showOpenDialog would put a real file picker on the developer's screen and
// block the handler until dismissed. Stub the modal dialogs so a future spec
// can neither hang the suite nor interrupt real work.
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });

const desktop = path.resolve(__dirname, "../../..");
app.setAppPath(desktop);

async function start() {
  const provider = await import("./provider-inventory.mjs");
  const bundle = require.resolve(path.join(desktop, "dist-electron/provider-inventory.cjs"));
  const fixture = new Module(bundle);
  fixture.filename = bundle;
  fixture.loaded = true;
  fixture.exports = {
    collectProviderInventory: provider.collectProviderInventory,
    createManagementProviders: provider.createManagementProviders,
    executeWorkItem: provider.executeWorkItem,
  };
  require.cache[bundle] = fixture;
  await import(pathToFileURL(path.join(desktop, "dist-electron/electron/main.js")).href);
}

start().catch(error => {
  console.error(error);
  app.exit(1);
});
