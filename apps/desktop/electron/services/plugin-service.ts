import type { ChildProcess } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PluginManager, readPluginConfiguration, validateManifest, type InstalledPluginRecord, type PluginRuntime } from "@afk/runtime/plugin-sdk";
import { withPluginRuntime } from "./runtime-service.js";
import { parsePluginEnabled, parsePluginId, parsePluginInstall, type DesktopPluginDiagnostic, type DesktopPluginList, type PluginInstallInput } from "../../shared/plugin-contract.js";

const diagnosticMessages: Record<string, string> = {
  "config.invalid": "插件配置文件无效，请在本机检查 plugins.yml。",
  "config.duplicate": "插件配置重复。",
  "config.provider-invalid": "插件配置未通过校验。",
  "config.integrations-invalid": "插件集成配置未通过校验。",
  "load.missing": "插件入口不存在，请重新安装。",
  "load.malformed": "插件未导出受支持的接口。",
  "load.id-mismatch": "插件 ID 与安装记录不一致。",
  "load.failed": "插件加载失败，请检查配置或重新安装。",
  "load.dependencies": "插件依赖缺失或循环，请检查启用状态及凭据 Provider 名称。",
  "activation.failed": "插件激活失败。",
  "diagnostics.failed": "插件诊断失败。",
};

type PluginServiceOptions = {
  homeDir?: string;
  manager?: Pick<PluginManager, "install" | "setEnabled" | "remove" | "configure">;
  createRuntime?: () => Promise<PluginRuntime>;
  chooseDirectory: () => Promise<string | undefined>;
  chooseJsonFile: () => Promise<string | undefined>;
  confirm: (operation: "install" | "configure", label: string) => Promise<boolean>;
};

export function createPluginService(options: PluginServiceOptions) {
  const homeDir = options.homeDir ?? homedir();
  const manager = options.manager ?? new PluginManager({ homeDir });
  const workers = new Set<ChildProcess>();
  let changingFiles = false;
  let activeRuntimes = 0;
  let runtimeSnapshot: Promise<DesktopPluginList> | undefined;

  async function withRuntime<Result>(operation: (runtime: PluginRuntime) => Promise<Result>): Promise<Result> {
    if (changingFiles) throw new Error("插件文件操作正在进行，请稍后重试");
    activeRuntimes += 1;
    try {
      return await withPluginRuntime({ homeDir, createRuntime: options.createRuntime }, operation);
    } catch { throw new Error("插件运行操作失败，请检查插件配置与运行状态后重试。"); }
    finally { activeRuntimes -= 1; }
  }

  async function inspectRuntime(): Promise<DesktopPluginList> {
    let entries: ReturnType<typeof readPluginConfiguration>["plugins"];
    try { entries = readPluginConfiguration(homeDir).plugins; } catch { entries = []; }
    return withRuntime(async runtime => {
      const plugins = runtime.listPlugins().map(id => {
        const manifest = runtime.getPlugin(id)!.manifest;
        const setting = entries.find(entry => entry.id === id);
        return { id, version: manifest.version, origin: setting && !setting.builtin ? "configured" as const : "builtin" as const, enabled: true, runtimeLoaded: true, capabilities: [...manifest.provides], configurable: true, removable: false };
      });
      const diagnostics = (await runtime.diagnostics()).map(diagnostic => {
        const code = Object.hasOwn(diagnosticMessages, diagnostic.code) ? diagnostic.code : "plugin.diagnostic";
        return { ...(diagnostic.pluginId ? { pluginId: parsePluginId(diagnostic.pluginId) } : {}), severity: diagnostic.severity, code, message: diagnosticMessages[code] ?? "插件报告诊断；详细信息留在本机，不向界面传递配置或原始错误。" };
      });
      return { plugins, diagnostics };
    });
  }

  async function list(): Promise<DesktopPluginList> {
    const snapshot = await (runtimeSnapshot ??= inspectRuntime().catch(() => ({ plugins: [], diagnostics: [{ severity: "error" as const, code: "runtime.inspect-failed", message: "插件运行时检查失败。" }] })));
    const diagnostics: DesktopPluginDiagnostic[] = snapshot.diagnostics.filter(diagnostic => diagnostic.code !== "config.invalid");
    let configuration: ReturnType<typeof readPluginConfiguration> | undefined;
    try { configuration = readPluginConfiguration(homeDir); }
    catch { diagnostics.push({ severity: "error", code: "config.invalid", message: diagnosticMessages["config.invalid"] }); }
    const installed = new Map<string, InstalledPluginRecord>();
    const directory = path.join(homeDir, ".afk", "plugins");
    const directories = await readdir(directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ severity: "error", code: "install.unreadable", message: "无法读取插件安装目录。" });
      return [];
    });
    for (const entry of directories.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))) {
      try {
        parsePluginId(entry.name);
        const record = JSON.parse(await readFile(path.join(directory, entry.name, "install.json"), "utf8")) as InstalledPluginRecord;
        validateManifest(record.manifest);
        if (record.id !== entry.name || record.manifest.id !== entry.name) throw new Error("Invalid install record");
        installed.set(entry.name, record);
      } catch { diagnostics.push({ severity: "error", code: "install.invalid", message: "某个插件安装记录无效，请在本机检查安装目录。" }); }
    }
    const ids = new Set([...snapshot.plugins.map(plugin => plugin.id), ...installed.keys(), ...(configuration?.plugins.map(plugin => plugin.id) ?? [])]);
    const plugins = [...ids].sort().map(id => {
      const loaded = snapshot.plugins.find(plugin => plugin.id === id);
      const record = installed.get(id);
      const setting = configuration?.plugins.find(plugin => plugin.id === id);
      const builtin = !record && (setting ? setting.builtin === true : loaded?.origin === "builtin");
      return {
        id, version: record?.manifest.version ?? loaded?.version,
        origin: record ? "installed" as const : builtin ? "builtin" as const : "configured" as const,
        enabled: setting?.enabled ?? (!!loaded || !!record), runtimeLoaded: !!loaded,
        capabilities: [...(record?.manifest.provides ?? loaded?.capabilities ?? [])],
        configurable: !!configuration && (!!record || (builtin && !id.startsWith("workflow."))), removable: !!record,
        configurationPresent: configuration ? setting?.config !== undefined : undefined,
      };
    });
    return { plugins, diagnostics };
  }

  async function find(id: string) {
    parsePluginId(id);
    const result = await list();
    if (result.diagnostics.some(diagnostic => diagnostic.code === "config.invalid")) throw new Error("请先修复本机 plugins.yml，再修改插件");
    const plugin = result.plugins.find(plugin => plugin.id === id);
    if (!plugin) throw new Error("插件不存在");
    return plugin;
  }

  async function hasRecordedWorker(): Promise<boolean> {
    const directory = path.join(homeDir, ".afk", "workspaces");
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.filter(entry => entry.isDirectory())) {
      let records: unknown;
      try { records = JSON.parse(await readFile(path.join(directory, entry.name, "work-item-runs.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!Array.isArray(records)) throw new Error("Invalid worker records");
      for (const record of records) {
        if (record.status !== "starting" && record.status !== "running") continue;
        if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return true;
        try { process.kill(record.pid, 0); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true; }
      }
    }
    return false;
  }

  async function changeFiles(operation: () => Promise<void>): Promise<void> {
    if (changingFiles) throw new Error("插件文件操作正在进行，请稍后重试");
    changingFiles = true;
    try {
      let active: boolean;
      try { active = activeRuntimes > 0 || workers.size > 0 || await hasRecordedWorker(); }
      catch { throw new Error("无法核实 Worker 状态，请检查本机运行记录后重试"); }
      if (active) throw new Error("仍有插件操作或 Worker 正在运行或启动；请等待结束后再修改插件");
      await operation();
    } finally { changingFiles = false; }
  }

  return {
    list,
    withRuntime,
    launchWorker(launch: () => ChildProcess): ChildProcess {
      if (changingFiles) throw new Error("插件文件操作正在进行，请稍后启动运行");
      const worker = launch();
      workers.add(worker);
      const release = () => workers.delete(worker);
      worker.once("exit", release);
      worker.once("error", release);
      return worker;
    },
    async install(input: PluginInstallInput): Promise<boolean> {
      const request = parsePluginInstall(input);
      const source = request.kind === "local" ? await options.chooseDirectory() : request.spec;
      if (!source) return false;
      if (request.kind === "local" && (!path.isAbsolute(source) || !(await stat(source)).isDirectory())) throw new Error("请选择本地插件目录");
      if (!await options.confirm("install", source)) return false;
      if ((await list()).diagnostics.some(diagnostic => diagnostic.code === "config.invalid")) throw new Error("请先修复本机 plugins.yml，再安装插件");
      await changeFiles(async () => {
        try { await manager.install(source); }
        catch { throw new Error("插件安装失败，请检查合法插件包、npm 可用性或插件管理锁；原安装由 PluginManager 保留"); }
      });
      return true;
    },
    async setEnabled(id: string, enabled: boolean): Promise<boolean> {
      parsePluginEnabled(enabled);
      const plugin = await find(id);
      if (enabled && plugin.origin === "configured") throw new Error("插件尚未安装，请先安装合法插件包");
      await changeFiles(async () => {
        try { await manager.setEnabled(id, enabled, plugin.origin === "builtin"); }
        catch { throw new Error("插件状态保存失败，请检查插件依赖、配置文件或插件管理锁"); }
      });
      return true;
    },
    async remove(id: string): Promise<boolean> {
      const plugin = await find(id);
      if (!plugin.removable) throw new Error("只能卸载已安装插件，内置插件可禁用");
      await changeFiles(async () => {
        try { await manager.remove(id); }
        catch { throw new Error("插件卸载失败，请检查插件依赖、本机安装目录或插件管理锁"); }
      });
      return true;
    },
    async configure(id: string): Promise<boolean> {
      const plugin = await find(id);
      if (!plugin.configurable) throw new Error("该插件尚不可配置");
      const file = await options.chooseJsonFile();
      if (!file) return false;
      if (!await options.confirm("configure", id)) return false;
      await changeFiles(async () => {
        try {
          const metadata = await stat(file);
          if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("Invalid config file");
          const config = JSON.parse(await readFile(file, "utf8"));
          if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid config object");
          await manager.configure(id, config, plugin.origin === "builtin");
        } catch { throw new Error("配置导入失败；请选择不超过 1 MiB、符合插件 schema 的 JSON 对象文件"); }
      });
      return true;
    },
  };
}
