import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

const PREFERRED_PORT = 5174;

/**
 * The e2e server must never reuse a Vite instance that already holds the
 * port: that instance may serve a different checkout's `main.tsx`. When the
 * preferred port is busy (a local dev server, for example) the suite used to
 * abort with an opaque "port is already used" error, so pick a free port
 * and keep the run going instead.
 *
 * Availability is probed by connecting, not by binding: a dev server bound to
 * `[::1]` and a probe bound to `::` coexist on macOS, so a bind probe
 * wrongly reports the port as free while Vite still fails to listen on it.
 */
function isPortInUse(port: number): boolean {
  const script = `const net=require('net');`
    + `const hosts=['127.0.0.1','::1'];`
    + `let pending=hosts.length, busy=false;`
    + `for (const host of hosts) {`
    + `  const socket=net.connect({ port: ${port}, host });`
    + `  socket.on('connect',()=>{ busy=true; socket.destroy(); });`
    + `  socket.on('error',()=>{});`
    + `  socket.on('close',()=>{ if (--pending===0) { console.log(busy?'busy':'free'); process.exit(0); } });`
    + `}`;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim() === "busy";
}

function findFreePort(): number {
  const script = `const s=require('net').createServer();`
    + `s.listen(0,()=>{console.log(s.address().port);s.close(()=>process.exit(0))});`;
  return Number(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim());
}

const port = process.env.AFK_E2E_PORT
  ? Number(process.env.AFK_E2E_PORT)
  : (isPortInUse(PREFERRED_PORT) ? findFreePort() : PREFERRED_PORT);

if (port !== PREFERRED_PORT) {
  console.log(`[e2e] port ${PREFERRED_PORT} is busy; using ${port} instead.`);
}

/**
 * Playwright + Electron end-to-end config for AFK Control.
 *
 * Boots the real Electron desktop client against a Vite dev server so the
 * renderer, preload, IPC handlers, and main process are all live in the
 * same window the user gets from `pnpm start`. A test-only Electron entry
 * substitutes provider snapshots and fixture binaries intercept CLI calls,
 * so the tests don't require real GitHub / GitLab credentials.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/_helpers/global-setup.ts",
  testIgnore: ["**/_helpers/**", "**/fixtures/**"],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "electron", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `./node_modules/.bin/vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    // The renderer source lives in this worktree; never reuse a stale Vite
    // from a different checkout (e.g. the main repo) that happens to be
    // bound to 5174 — that would serve the wrong main.tsx.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
