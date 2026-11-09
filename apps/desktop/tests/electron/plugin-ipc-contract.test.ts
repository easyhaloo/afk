import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopApi } from "../../shared/ipc-contract.js";
import { parsePluginInstall } from "../../shared/plugin-contract.js";
import { parseExperienceScope } from "../../shared/experience-contract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  api: undefined as DesktopApi | undefined,
  invoke: vi.fn().mockResolvedValue(true),
  service: { list: vi.fn().mockResolvedValue({ plugins: [], diagnostics: [] }), install: vi.fn().mockResolvedValue(true), setEnabled: vi.fn().mockResolvedValue(true), remove: vi.fn().mockResolvedValue(true), configure: vi.fn().mockResolvedValue(true), launchWorker: vi.fn() },
  google: { status: vi.fn().mockResolvedValue({ connected: false }), login: vi.fn().mockResolvedValue({ connected: true, email: "me@example.com" }), cancel: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined) },
  experiences: { projects: vi.fn().mockResolvedValue(["github:acme/api"]), list: vi.fn().mockResolvedValue([]), verify: vi.fn(), revoke: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/afk-plugin-ipc" },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopApi) => { mocks.api = api; } },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../../electron/services/plugin-service.js", () => ({ createPluginService: () => mocks.service }));
vi.mock("../../electron/services/google-auth-service.js", () => ({ createGoogleAuthService: () => mocks.google }));
vi.mock("../../electron/services/experience-service.js", () => ({ createExperienceService: () => mocks.experiences }));

const trusted = { senderFrame: { url: "http://localhost:5174" } };

describe("plugin main/preload boundary", () => {
  beforeAll(async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5174";
    const { registerIpcHandlers } = await import("../../electron/ipc/register-handlers.js");
    registerIpcHandlers();
    await import("../../electron/preload.cts");
  });
  beforeEach(() => vi.clearAllMocks());

  it("exposes only fixed plugin methods and forwards all arguments through typed preload", async () => {
    const api = mocks.api!.plugins;
    expect(Object.keys(api).sort()).toEqual(["configure", "google", "install", "list", "remove", "setEnabled"]);
    await api.list();
    await api.install({ kind: "npm", spec: "@example/plugin@1.0.0" });
    await api.install({ kind: "local" });
    await api.setEnabled("context.example", false);
    await api.remove("context.example");
    await api.configure("context.example");
    expect(mocks.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.pluginsList], [IPC_CHANNELS.pluginsInstall, { kind: "npm", spec: "@example/plugin@1.0.0" }],
      [IPC_CHANNELS.pluginsInstall, { kind: "local" }], [IPC_CHANNELS.pluginsSetEnabled, "context.example", false],
      [IPC_CHANNELS.pluginsRemove, "context.example"], [IPC_CHANNELS.pluginsConfigure, "context.example"],
    ]);
  });

  it("whitelists Google and experience methods and validates inputs before service access", async () => {
    expect(parseExperienceScope("gitlab:git.example.com:8443/team/api")).toBe("gitlab:git.example.com:8443/team/api");
    expect(parseExperienceScope("gitlab:123")).toBe("gitlab:123");
    for (const scope of ["all", "github:../api", "github:acme/../api", "gitlab:git.example.com:99999/team/api", "github:acme/api#1"]) expect(() => parseExperienceScope(scope)).toThrow();
    expect(Object.keys(mocks.api!.plugins.google).sort()).toEqual(["cancel", "login", "logout", "status"]);
    expect(Object.keys(mocks.api!.experiences).sort()).toEqual(["list", "projects", "revoke", "verify"]);
    await mocks.api!.plugins.google.login();
    await mocks.api!.plugins.google.cancel();
    await mocks.api!.plugins.google.status();
    await mocks.api!.plugins.google.logout();
    await mocks.api!.experiences.projects();
    const selection = { scope: "github:acme/api", id: "e79b6ea0-a82d-4639-9f0e-a358eedbe2aa" };
    await mocks.api!.experiences.list({ scope: selection.scope, prompt: "network" });
    await mocks.api!.experiences.verify({ ...selection, runId: "qa-run", action: "Correct network setup" });
    await mocks.api!.experiences.revoke(selection);
    expect(mocks.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.googleLogin], [IPC_CHANNELS.googleCancel], [IPC_CHANNELS.googleStatus], [IPC_CHANNELS.googleLogout],
      [IPC_CHANNELS.experiencesProjects], [IPC_CHANNELS.experiencesList, { scope: selection.scope, prompt: "network" }],
      [IPC_CHANNELS.experiencesVerify, { ...selection, runId: "qa-run", action: "Correct network setup" }], [IPC_CHANNELS.experiencesRevoke, selection],
    ]);
    for (const channel of [IPC_CHANNELS.googleStatus, IPC_CHANNELS.googleLogin, IPC_CHANNELS.googleCancel, IPC_CHANNELS.googleLogout, IPC_CHANNELS.experiencesProjects, IPC_CHANNELS.experiencesList, IPC_CHANNELS.experiencesVerify, IPC_CHANNELS.experiencesRevoke]) {
      await expect(mocks.handlers.get(channel)!({ senderFrame: { url: "https://untrusted.example" } }, selection)).rejects.toThrow("拒绝");
    }
    await expect(mocks.handlers.get(IPC_CHANNELS.googleLogin)!(trusted, { clientFile: "/tmp/secret.json" })).rejects.toThrow();
    for (const input of [null, { scope: "all" }, { scope: "github:acme/api", file: "/tmp/other.sqlite" }, { scope: "github:acme/api", prompt: "x".repeat(2001) }]) {
      await expect(mocks.handlers.get(IPC_CHANNELS.experiencesList)!(trusted, input)).rejects.toThrow();
    }
    for (const input of [{ ...selection, id: "../file" }, { ...selection, runId: "qa-run", action: " " }, { ...selection, runId: "qa-run", action: "fix", verified: true }, { ...selection, runId: "qa-run\0", action: "fix" }]) {
      await expect(mocks.handlers.get(IPC_CHANNELS.experiencesVerify)!(trusted, input)).rejects.toThrow();
    }
    expect(mocks.google.login).not.toHaveBeenCalled();
    expect(mocks.experiences.list).not.toHaveBeenCalled();
    expect(mocks.experiences.verify).not.toHaveBeenCalled();
    await mocks.handlers.get(IPC_CHANNELS.experiencesRevoke)!(trusted, selection);
    expect(mocks.experiences.revoke).toHaveBeenCalledWith(selection);
  });

  it.each(["destroyed", "render-process-gone", "did-start-navigation"])("cancels OAuth on %s and removes lifecycle listeners after completion", async lifecycle => {
    const { EventEmitter } = await import("node:events");
    const sender = new EventEmitter();
    let finish!: () => void;
    mocks.google.login.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(null); }));
    const result = mocks.handlers.get(IPC_CHANNELS.googleLogin)!({ ...trusted, sender });
    sender.emit(lifecycle);
    expect(mocks.google.cancel).toHaveBeenCalledOnce();
    finish();
    await result;
    expect(sender.eventNames()).toEqual([]);
  });

  it("routes valid requests to the service without renderer filesystem access", async () => {
    await mocks.handlers.get(IPC_CHANNELS.pluginsList)!(trusted);
    await mocks.handlers.get(IPC_CHANNELS.pluginsInstall)!(trusted, { kind: "local" });
    await mocks.handlers.get(IPC_CHANNELS.pluginsSetEnabled)!(trusted, "context.example", false);
    await mocks.handlers.get(IPC_CHANNELS.pluginsRemove)!(trusted, "context.example");
    await mocks.handlers.get(IPC_CHANNELS.pluginsConfigure)!(trusted, "context.example");
    expect(mocks.service.list).toHaveBeenCalledOnce();
    expect(mocks.service.install).toHaveBeenCalledWith({ kind: "local" });
    expect(mocks.service.setEnabled).toHaveBeenCalledWith("context.example", false);
    expect(mocks.service.remove).toHaveBeenCalledWith("context.example");
    expect(mocks.service.configure).toHaveBeenCalledWith("context.example");
  });

  it("rejects untrusted senders for every plugin operation", async () => {
    for (const channel of [IPC_CHANNELS.pluginsList, IPC_CHANNELS.pluginsInstall, IPC_CHANNELS.pluginsSetEnabled, IPC_CHANNELS.pluginsRemove, IPC_CHANNELS.pluginsConfigure]) {
      await expect(mocks.handlers.get(channel)!({ senderFrame: { url: "https://untrusted.example" } }, "context.example", true)).rejects.toThrow("拒绝");
    }
    expect(mocks.service.list).not.toHaveBeenCalled();
    expect(mocks.service.install).not.toHaveBeenCalled();
    expect(mocks.service.setEnabled).not.toHaveBeenCalled();
    expect(mocks.service.remove).not.toHaveBeenCalled();
    expect(mocks.service.configure).not.toHaveBeenCalled();
  });

  it("validates IDs, required booleans, npm sources and native-only file selection", async () => {
    for (const id of ["../example", "context.example\0", "afk.internal", 123, undefined]) {
      await expect(mocks.handlers.get(IPC_CHANNELS.pluginsRemove)!(trusted, id)).rejects.toThrow();
      await expect(mocks.handlers.get(IPC_CHANNELS.pluginsConfigure)!(trusted, id)).rejects.toThrow();
    }
    for (const enabled of ["false", 0, undefined]) await expect(mocks.handlers.get(IPC_CHANNELS.pluginsSetEnabled)!(trusted, "context.example", enabled)).rejects.toThrow();
    await expect(mocks.handlers.get(IPC_CHANNELS.pluginsSetEnabled)!(trusted)).rejects.toThrow();
    for (const input of [{ kind: "local", path: "/etc/passwd" }, { kind: "npm", spec: "--force" }, { kind: "npm", spec: "https://token@example.test/package.tgz" }, { kind: "npm", spec: "file:/tmp/plugin" }, null]) {
      await expect(mocks.handlers.get(IPC_CHANNELS.pluginsInstall)!(trusted, input)).rejects.toThrow();
    }
    expect(mocks.service.install).not.toHaveBeenCalled();
    expect(mocks.service.setEnabled).not.toHaveBeenCalled();
    expect(mocks.service.remove).not.toHaveBeenCalled();
  });

  it("accepts named npm versions/tags and rejects shell and URL syntax", () => {
    for (const spec of ["example-plugin", "@example/plugin@1.2.3", "example-plugin@next", "example-plugin@^1.0.0"]) expect(parsePluginInstall({ kind: "npm", spec })).toEqual({ kind: "npm", spec });
    for (const spec of ["plugin;echo secret", "$(touch bad)", "git+https://example.test/plugin", "../plugin"]) expect(() => parsePluginInstall({ kind: "npm", spec })).toThrow();
  });
});
