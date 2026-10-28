import { afterEach, expect, it, vi } from "vitest";
import { workspaceStateDirectory } from "@afk/runtime/infrastructure/workspace";
import path from "node:path";

const bootstrap = vi.hoisted(() => ({
  packaged: false,
  lock: true,
  setPath: vi.fn(),
  requestLock: vi.fn(),
  quit: vi.fn(),
  mkdir: vi.fn(),
  write: vi.fn(),
  createWindow: vi.fn(),
  startup: Promise.resolve(),
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() { return bootstrap.packaged; },
    setPath: bootstrap.setPath,
    getPath: () => "/user-data",
    requestSingleInstanceLock: () => { bootstrap.requestLock(); return bootstrap.lock; },
    quit: bootstrap.quit,
    on: vi.fn(),
    whenReady: () => ({ then: (callback: () => Promise<void>) => { bootstrap.startup = callback(); } }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("node:fs", () => ({ mkdirSync: bootstrap.mkdir, writeFileSync: bootstrap.write }));
vi.mock("../../electron/ipc/register-handlers.js", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("../../electron/services/update-service.js", () => ({ registerUpdateService: vi.fn() }));
vi.mock("../../electron/services/workspace-preference-service.js", () => ({ readWorkspacePreference: vi.fn() }));
vi.mock("../../electron/window/main-window.js", () => ({ createMainWindow: bootstrap.createWindow }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  bootstrap.packaged = false;
  bootstrap.lock = true;
});

it("isolates the development instance before locking and signals readiness only after the window loads", async () => {
  vi.stubEnv("AFK_CONTROL_READY_FILE", "/checkout/.dev/ready");
  let loaded!: () => void;
  bootstrap.createWindow.mockReturnValueOnce(new Promise<void>((resolve) => { loaded = resolve; }));
  await import("../../electron/main.js");
  expect(bootstrap.setPath).toHaveBeenCalledWith("userData", "/checkout/.dev/user-data");
  expect(bootstrap.setPath.mock.invocationCallOrder[0]).toBeLessThan(bootstrap.requestLock.mock.invocationCallOrder[0]);
  expect(bootstrap.write).not.toHaveBeenCalled();
  loaded();
  await bootstrap.startup;
  expect(bootstrap.write).toHaveBeenCalledWith("/checkout/.dev/ready", String(process.pid));
});

it("keeps packaged application data in AFK home without publishing development readiness", async () => {
  bootstrap.packaged = true;
  vi.stubEnv("AFK_CONTROL_READY_FILE", "/checkout/.dev/ready");
  await import("../../electron/main.js");
  await bootstrap.startup;
  expect(bootstrap.setPath).toHaveBeenCalledWith("userData", path.join(workspaceStateDirectory(), "desktop"));
  expect(bootstrap.write).not.toHaveBeenCalled();
});

it("does not report ready when the instance lock is unavailable", async () => {
  bootstrap.lock = false;
  await import("../../electron/main.js");
  expect(bootstrap.quit).toHaveBeenCalled();
  expect(bootstrap.createWindow).not.toHaveBeenCalled();
  expect(bootstrap.write).not.toHaveBeenCalled();
});
