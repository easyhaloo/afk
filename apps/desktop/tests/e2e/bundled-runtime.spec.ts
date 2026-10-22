import { test, expect, _electron as electron } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { E2E_ENTRY, RENDERER_URL } from "./_helpers/launch.js";

test("boots with the shared runtime and loads its worker without a CLI override", async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "afk-runtime-e2e-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(path.join(workspace, ".afk"), { recursive: true });
  const app = await electron.launch({
    args: [E2E_ENTRY, `--user-data-dir=${path.join(root, "user-data")}`],
    env: { ...process.env, HOME: root, USERPROFILE: root, AFK_WORKSPACE: workspace, AFK_E2E_PRODUCTION_MAIN: "1", ELECTRON_RENDERER_URL: RENDERER_URL },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".primary-nav")).toBeVisible();
    const snapshot = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(snapshot.afk).toMatchObject({ available: true, executable: "@afk/runtime" });
    expect(snapshot.workspace.root).toBe(workspace);

    const executable = await app.evaluate(() => process.execPath);
    const desktop = await app.evaluate(({ app }) => app.getAppPath());
    const worker = spawnSync(executable, [path.join(desktop, "dist-electron/execution-worker.js"), JSON.stringify({
      workItemId: "github:acme/api#42", manifestPath: path.join(root, "missing-manifest.json"),
    })], { cwd: workspace, env: { ...process.env, HOME: root, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15_000 });
    expect(worker.error).toBeUndefined();
    expect(worker.status).toBe(1);
    expect(worker.stderr).toContain("file does not exist");
    expect(worker.stderr).toContain("missing-manifest.json");
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
