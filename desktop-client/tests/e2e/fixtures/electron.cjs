const { app } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");

const desktop = path.resolve(__dirname, "../../..");
app.setAppPath(desktop);

async function start() {
  const provider = await import("./provider-inventory.mjs");
  const bundle = require.resolve(path.join(desktop, "dist-electron/provider-inventory.cjs"));
  const fixture = new Module(bundle);
  fixture.filename = bundle;
  fixture.loaded = true;
  fixture.exports = { collectProviderInventory: provider.collectProviderInventory };
  require.cache[bundle] = fixture;
  await import(pathToFileURL(path.join(desktop, "dist-electron/electron/main.js")).href);
}

start().catch(error => {
  console.error(error);
  app.exit(1);
});
