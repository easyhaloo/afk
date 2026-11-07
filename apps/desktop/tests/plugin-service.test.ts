import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginManager, PluginRuntime, readPluginConfiguration } from "@afk/runtime/plugin-sdk";
import { createPluginService } from "../electron/services/plugin-service.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-plugin-"));
  roots.push(root);
  const homeDir = path.join(root, "home");
  const source = path.join(root, "source");
  await mkdir(path.join(source, "dist"), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "desktop-example", type: "module" }));
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ id: "desktop.example", version: "1.0.0", apiVersion: 1, trusted: true, provides: ["surface.desktop"], configSchema: { type: "object", properties: { token: { type: "string" } }, additionalProperties: false } }));
  await writeFile(path.join(source, "dist/index.js"), "throw new Error('Management must not execute a newly installed surface');");
  const manager = new PluginManager({ homeDir, runNpm: vi.fn(async () => { throw new Error("No network in tests"); }) });
  const runtime = new PluginRuntime();
  await runtime.load({ manifest: { id: "context.builtin", version: "1.0.0", apiVersion: 1, trusted: true, provides: ["context.provider"] }, activate() {} });
  runtime.recordDiagnostic({ pluginId: "context.builtin", severity: "warning", code: "config.provider-invalid", message: "TOP_SECRET", details: { token: "TOP_SECRET" } });
  runtime.recordDiagnostic({ severity: "error", code: "TOP_SECRET", message: "TOP_SECRET" });
  const createRuntime = vi.fn(async () => runtime);
  const chooseDirectory = vi.fn(async (): Promise<string | undefined> => source);
  const jsonFile = path.join(root, "config.json");
  const chooseJsonFile = vi.fn(async (): Promise<string | undefined> => jsonFile);
  const confirm = vi.fn(async () => true);
  const service = createPluginService({ homeDir, manager, createRuntime, chooseDirectory, chooseJsonFile, confirm });
  return { root, source, homeDir, jsonFile, manager, runtime, createRuntime, chooseDirectory, chooseJsonFile, confirm, service };
}

describe("Desktop plugin management", () => {
  it("does not offer configuration for workflow runtime modules", async () => {
    const { service, runtime, chooseJsonFile } = await fixture();
    await runtime.load({ manifest: { id: "workflow.capabilities", version: "0.1.0", apiVersion: 1, provides: ["workflow.action"], trusted: true }, activate() {} });
    expect((await service.list()).plugins.find(plugin => plugin.id === "workflow.capabilities")?.configurable).toBe(false);
    await expect(service.configure("workflow.capabilities")).rejects.toThrow("不可配置");
    expect(chooseJsonFile).not.toHaveBeenCalled();
  });

  it("installs, configures, toggles and removes through PluginManager without executing new UI code or exposing secrets", async () => {
    const fixtureData = await fixture();
    const { service, homeDir, jsonFile, createRuntime, runtime } = fixtureData;
    const dispose = vi.spyOn(runtime, "dispose");
    expect(await service.install({ kind: "local" })).toBe(true);
    await writeFile(jsonFile, JSON.stringify({ token: "TOP_SECRET" }));
    expect(await service.configure("desktop.example")).toBe(true);
    expect(readPluginConfiguration(homeDir).plugins.find(plugin => plugin.id === "desktop.example")?.config).toEqual({ token: "TOP_SECRET" });
    await service.setEnabled("desktop.example", false);
    let result = await service.list();
    expect(result.plugins.find(plugin => plugin.id === "desktop.example")).toMatchObject({ origin: "installed", enabled: false, runtimeLoaded: false, capabilities: ["surface.desktop"], configurable: true, removable: true });
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(result)).not.toContain("configSchema");
    await service.setEnabled("desktop.example", true);
    expect(await service.remove("desktop.example")).toBe(true);
    expect(readPluginConfiguration(homeDir).plugins.find(plugin => plugin.id === "desktop.example")).toMatchObject({ enabled: false, config: { token: "TOP_SECRET" } });
    result = await service.list();
    expect(result.plugins.find(plugin => plugin.id === "desktop.example")).toMatchObject({ origin: "configured", removable: false, configurable: false });
    await expect(service.setEnabled("desktop.example", true)).rejects.toThrow("尚未安装");
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("persists builtin enable/disable with the correct manager flag and prevents builtin removal", async () => {
    const { service, manager, homeDir, runtime } = await fixture();
    await runtime.load({ manifest: { id: "workflow.capabilities", version: "0.1.0", apiVersion: 1, provides: ["workflow.action"], trusted: true }, activate() {} });
    const setEnabled = vi.spyOn(manager, "setEnabled");
    await service.setEnabled("workflow.capabilities", false);
    expect(setEnabled).toHaveBeenLastCalledWith("workflow.capabilities", false, true);
    expect(readPluginConfiguration(homeDir).plugins[0]).toMatchObject({ builtin: true, enabled: false });
    await service.setEnabled("workflow.capabilities", true);
    await expect(service.remove("workflow.capabilities")).rejects.toThrow("内置插件可禁用");
  });

  it("passes confirmed npm package specs to PluginManager without installing real packages", async () => {
    const { service, manager, confirm, chooseDirectory } = await fixture();
    const install = vi.spyOn(manager, "install").mockResolvedValue({} as Awaited<ReturnType<PluginManager["install"]>>);
    expect(await service.install({ kind: "npm", spec: "@example/plugin@1.2.3" })).toBe(true);
    expect(confirm).toHaveBeenCalledWith("install", "@example/plugin@1.2.3");
    expect(install).toHaveBeenCalledWith("@example/plugin@1.2.3");
    expect(chooseDirectory).not.toHaveBeenCalled();
  });

  it("does not treat installed plugins shadowing a builtin ID as builtin, even after removal", async () => {
    const { service, source, manager } = await fixture();
    const metadata = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
    await writeFile(path.join(source, "plugin.json"), JSON.stringify({ ...metadata, id: "context.builtin" }));
    await service.install({ kind: "local" });
    const setEnabled = vi.spyOn(manager, "setEnabled");
    await service.setEnabled("context.builtin", false);
    expect(setEnabled).toHaveBeenLastCalledWith("context.builtin", false, false);
    expect((await service.list()).plugins.find(plugin => plugin.id === "context.builtin")?.origin).toBe("installed");
    await service.remove("context.builtin");
    expect((await service.list()).plugins.find(plugin => plugin.id === "context.builtin")?.origin).toBe("configured");
  });

  it("handles canceled dialogs without writes and redacts configuration validation errors", async () => {
    const { service, chooseDirectory, chooseJsonFile, jsonFile, manager, confirm, homeDir } = await fixture();
    const install = vi.spyOn(manager, "install");
    chooseDirectory.mockResolvedValueOnce(undefined);
    expect(await service.install({ kind: "local" })).toBe(false);
    confirm.mockResolvedValueOnce(false);
    expect(await service.install({ kind: "npm", spec: "@example/plugin@1.0.0" })).toBe(false);
    expect(install).not.toHaveBeenCalled();
    chooseJsonFile.mockResolvedValueOnce(undefined);
    expect(await service.configure("context.builtin")).toBe(false);
    await service.install({ kind: "local" });
    await writeFile(jsonFile, '{"token": "TOP_SECRET", BROKEN}');
    await expect(service.configure("desktop.example")).rejects.toThrow("配置导入失败");
    expect(readPluginConfiguration(homeDir).plugins.find(plugin => plugin.id === "desktop.example")?.config).toBeUndefined();
    await writeFile(jsonFile, JSON.stringify({ token: 123 }));
    await expect(service.configure("desktop.example")).rejects.toThrow("schema");
  });

  it("blocks package mutation while a worker runs, and blocks new workers during mutation", async () => {
    const { service, manager } = await fixture();
    const worker = new EventEmitter() as ChildProcess;
    service.launchWorker(() => worker);
    await expect(service.install({ kind: "local" })).rejects.toThrow("Worker");
    worker.emit("exit", 0);
    let finish!: () => void;
    let entered!: () => void;
    const installing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(manager, "install").mockImplementationOnce(async () => {
      entered();
      await new Promise<void>(resolve => { finish = resolve; });
      return {} as Awaited<ReturnType<PluginManager["install"]>>;
    });
    const operation = service.install({ kind: "local" });
    await installing;
    expect(() => service.launchWorker(() => worker)).toThrow("稍后启动");
    finish();
    await expect(operation).resolves.toBe(true);
    expect(service.launchWorker(() => worker)).toBe(worker);
    worker.emit("error", new Error("spawn failed"));
  });

  it("protects workers recorded by an earlier Desktop process and retains their files", async () => {
    const { service, homeDir } = await fixture();
    await service.install({ kind: "local" });
    const directory = path.join(homeDir, ".afk/workspaces/example");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "work-item-runs.json"), JSON.stringify([{ status: "running", pid: process.pid }]));
    await expect(service.remove("desktop.example")).rejects.toThrow("Worker");
    expect(await readFile(path.join(homeDir, ".afk/plugins/desktop.example/install.json"), "utf8")).toContain("desktop.example");
    await writeFile(path.join(directory, "work-item-runs.json"), "INVALID TOP_SECRET");
    await expect(service.remove("desktop.example")).rejects.toThrow("无法核实 Worker 状态");
  });

  it("keeps listing usable for invalid configuration and blocks state mutations", async () => {
    const { service, homeDir } = await fixture();
    await service.list();
    await mkdir(path.join(homeDir, ".afk"), { recursive: true });
    await writeFile(path.join(homeDir, ".afk/plugins.yml"), "plugins: TOP_SECRET");
    expect((await service.list()).diagnostics).toContainEqual(expect.objectContaining({ code: "config.invalid" }));
    await expect(service.setEnabled("context.builtin", false)).rejects.toThrow("请先修复");
    expect(await readFile(path.join(homeDir, ".afk/plugins.yml"), "utf8")).toBe("plugins: TOP_SECRET");
  });
});
