import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginManager, PluginRuntime, readPluginConfiguration } from "@afk/runtime/plugin-sdk";
import { createPluginService } from "../electron/services/plugin-service.js";
import { createLearningService } from "../electron/services/learning-service.js";

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
  it("keeps one saved configuration throughout learning preflight, mutation and postflight", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "learning-config-"));
    roots.push(homeDir);
    const manager = new PluginManager({ homeDir });
    const firstFile = path.join(homeDir, "first.json");
    const secondFile = path.join(homeDir, "second.json");
    const configurationFile = path.join(homeDir, "import.json");
    await manager.configure("learning.distiller", { enabled: true, validation: { configurationFile: firstFile } }, true);
    await writeFile(configurationFile, JSON.stringify({ enabled: true, validation: { configurationFile: secondFile } }));
    const scope = "github:acme/api";
    const candidateId = "a".repeat(64);
    let version = 1;
    const generations: string[] = [];
    const disposals: ReturnType<typeof vi.spyOn>[] = [];
    const service = createPluginService({ homeDir, manager, chooseDirectory: async () => undefined,
      chooseJsonFile: async () => configurationFile, confirm: async () => true, createRuntime: async () => {
        const configuration = readPluginConfiguration(homeDir).plugins.find(plugin => plugin.id === "learning.distiller")!.config!;
        const generation = (configuration.validation as { configurationFile: string }).configurationFile;
        const runtime = new PluginRuntime();
        await runtime.activate({ manifest: { id: "learning.distiller", version: "1.0.0", apiVersion: 1,
          trusted: true, provides: ["workflow.action"] }, activate(context) {
          context.registerSystemAction("learning.candidates", () => [{ id: candidateId, requestKey: "b".repeat(64), version,
            state: version === 1 ? "candidate" : "validated", proposal: { kind: "fact", title: "Approval", evidenceIds: ["observed"], applicability: { project: scope } } }]);
          context.registerSystemAction("learning.validate", () => {
            generations.push(generation); version = 2;
            return { status: "validated", candidateId, candidateVersion: 1, validatedVersion: 2,
              executionId: "11111111-1111-4111-8111-111111111111", receiptDigest: "d".repeat(64) };
          });
        } });
        disposals.push(vi.spyOn(runtime, "dispose"));
        return runtime;
      } });
    await service.list();
    let inventoryCalls = 0;
    const learning = createLearningService({ projects: async () => {
      if (++inventoryCalls === 2) await expect(service.configure("learning.distiller")).rejects.toThrow("仍有插件操作或 Worker");
      return [scope];
    }, withRuntime: operation => service.withRuntime(operation) });
    await expect(learning.validate({ scope, candidateId, expectedVersion: 1, checkerId: "verify.domain" }))
      .resolves.toEqual({ status: "validated", candidateId, candidateVersion: 1, validatedVersion: 2 });
    expect(generations).toEqual([firstFile]);
    expect(disposals).toHaveLength(2);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
    await expect(service.configure("learning.distiller")).resolves.toBe(true);
    const configured = readPluginConfiguration(homeDir).plugins.find(plugin => plugin.id === "learning.distiller")!.config!;
    expect(configured.validation).toEqual({ configurationFile: secondFile });
  });

  it.each(["create", "action", "dispose"] as const)("blocks file changes during runtime %s", async stage => {
    const { service, runtime, createRuntime } = await fixture();
    await service.list();
    createRuntime.mockClear();
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    createRuntime.mockImplementation(async () => {
      if (stage === "create") { entered(); await pending; }
      return runtime;
    });
    const dispose = vi.spyOn(runtime, "dispose").mockImplementation(async () => {
      if (stage === "dispose") { entered(); await pending; }
    });
    const action = service.withRuntime(async active => {
      expect(active).toBe(runtime);
      if (stage === "action") { entered(); await pending; }
      return "complete";
    });
    await started;
    await expect(service.install({ kind: "local" })).rejects.toThrow("运行");
    await expect(service.setEnabled("context.builtin", false)).rejects.toThrow("运行");
    finish();
    await expect(action).resolves.toBe("complete");
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not create an action runtime while installation owns plugin files", async () => {
    const { service, manager, createRuntime } = await fixture();
    await service.list();
    createRuntime.mockClear();
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(manager, "install").mockImplementation(async () => { entered(); await pending; return {} as never; });
    const installation = service.install({ kind: "local" });
    await started;
    await expect(service.withRuntime(async () => "blocked")).rejects.toThrow("文件操作");
    expect(createRuntime).not.toHaveBeenCalled();
    finish();
    await expect(installation).resolves.toBe(true);
    await expect(service.withRuntime(async () => "ready")).resolves.toBe("ready");
  });

  it.each(["create", "action", "dispose"] as const)("redacts %s failures and releases action ownership", async stage => {
    const { root, runtime } = await fixture();
    const dispose = vi.spyOn(runtime, "dispose").mockImplementation(async () => {
      if (stage === "dispose") throw "PRIVATE_RUNTIME_SECRET";
    });
    const createRuntime = vi.fn(async () => {
      if (stage === "create") throw new Error("PRIVATE_RUNTIME_SECRET");
      return runtime;
    });
    const service = createPluginService({ homeDir: root, createRuntime, chooseDirectory: async () => undefined,
      chooseJsonFile: async () => undefined, confirm: async () => true });
    const result = service.withRuntime(async () => {
      if (stage === "action") throw new Error("PRIVATE_RUNTIME_SECRET");
      return "complete";
    });
    await expect(result).rejects.toThrow("插件运行操作失败，请检查插件配置与运行状态后重试。");
    expect(dispose).toHaveBeenCalledTimes(stage === "create" ? 0 : 1);
    createRuntime.mockResolvedValue(runtime);
    dispose.mockResolvedValue(undefined);
    await expect(service.withRuntime(async () => "next")).resolves.toBe("next");
  });

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
