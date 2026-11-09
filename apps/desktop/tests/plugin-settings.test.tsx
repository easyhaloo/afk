import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPluginList } from "../shared/plugin-contract.js";
import { PluginSettings } from "../src/features/settings/PluginSettings.js";
import { Settings } from "../src/features/settings/SettingsPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

const inventory: DesktopPluginList = {
  plugins: [
    { id: "context.builtin", version: "1.0.0", origin: "builtin", enabled: true, runtimeLoaded: true, capabilities: ["context.provider"], configurable: true, removable: false },
    { id: "desktop.example", version: "2.0.0", origin: "installed", enabled: false, runtimeLoaded: false, capabilities: ["surface.desktop"], configurable: true, removable: true },
    { id: "context.removed", origin: "configured", enabled: false, runtimeLoaded: false, capabilities: [], configurable: false, removable: false },
  ], diagnostics: [{ pluginId: "desktop.example", severity: "warning", code: "load.missing", message: "插件入口不存在，请重新安装。" }],
};

async function render(settingsPage = false) {
  const plugins = { list: vi.fn().mockResolvedValue(inventory), setEnabled: vi.fn().mockResolvedValue(true), install: vi.fn().mockResolvedValue(true), remove: vi.fn().mockResolvedValue(true), configure: vi.fn().mockResolvedValue(true) };
  vi.stubGlobal("window", { afkDesktop: { plugins: { ...plugins, google: { status: vi.fn().mockResolvedValue({ connected: false }), cancel: vi.fn().mockResolvedValue(undefined) } }, experiences: { projects: vi.fn().mockResolvedValue([]) } } });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(settingsPage
    ? createElement(Settings, { appearance: { fontFamily: "system", fontScale: "medium", theme: "light", handDrawnHeaders: true }, onChange: vi.fn(), updateStatus: { state: "idle" }, onCheckUpdate: vi.fn(), onDownloadUpdate: vi.fn(), onInstallUpdate: vi.fn() })
    : createElement(PluginSettings)); });
  return { renderer, plugins };
}

describe("plugin settings", () => {
  it("is mounted in Settings and renders actual inventory, diagnostics and future-run semantics", async () => {
    const { renderer, plugins } = await render(true);
    expect(renderer.root.findByProps({ "aria-label": "插件管理" })).toBeTruthy();
    const content = JSON.stringify(renderer.toJSON());
    expect(content).toContain("surface.desktop");
    expect(content).toContain("load.missing");
    expect(content).toContain("后续运行");
    expect(renderer.root.findAllByProps({ "aria-label": "卸载 context.builtin" })).toHaveLength(0);
    expect(renderer.root.findByProps({ "aria-label": "启用 context.removed" }).props.disabled).toBe(true);
    expect(plugins.install).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("persists enable/disable through preload and refreshes the result", async () => {
    const { renderer, plugins } = await render();
    await act(async () => { renderer.root.findByProps({ "aria-label": "禁用 context.builtin" }).props.onClick(); });
    expect(plugins.setEnabled).toHaveBeenCalledWith("context.builtin", false);
    await act(async () => { renderer.root.findByProps({ "aria-label": "启用 desktop.example" }).props.onClick(); });
    expect(plugins.setEnabled).toHaveBeenCalledWith("desktop.example", true);
    expect(plugins.list).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(renderer.toJSON())).toContain("已保存");
    act(() => renderer.unmount());
  });

  it("installs local/npm packages only after explicit input and imports JSON through the main process", async () => {
    const { renderer, plugins } = await render();
    act(() => renderer.root.findByProps({ "aria-label": "安装插件" }).props.onClick());
    const input = renderer.root.findByProps({ "aria-label": "npm 插件包" });
    act(() => input.props.onChange({ target: { value: " @example/plugin@1.0.0 " } }));
    await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(plugins.install).toHaveBeenCalledWith({ kind: "npm", spec: "@example/plugin@1.0.0" });
    const local = renderer.root.findAllByType("button").find(button => button.children.includes("选择本地目录"))!;
    await act(async () => { local.props.onClick(); });
    expect(plugins.install).toHaveBeenCalledWith({ kind: "local" });
    await act(async () => { renderer.root.findByProps({ "aria-label": "导入 desktop.example 配置 JSON" }).props.onClick(); });
    expect(plugins.configure).toHaveBeenCalledWith("desktop.example");
    act(() => renderer.unmount());
  });

  it("requires the existing confirmation dialog before uninstalling", async () => {
    const { renderer, plugins } = await render();
    act(() => renderer.root.findByProps({ "aria-label": "卸载 desktop.example" }).props.onClick());
    expect(plugins.remove).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "dialog" }).props["aria-label"]).toBe("卸载插件");
    await act(async () => { renderer.root.findAllByType("button").find(button => button.props["aria-label"] === "确认卸载插件")!.props.onClick(); });
    expect(plugins.remove).toHaveBeenCalledWith("desktop.example");
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("keeps controls disabled during an IPC operation and reports failures with retry", async () => {
    const { renderer, plugins } = await render();
    let reject!: (error: Error) => void;
    plugins.configure.mockImplementationOnce(() => new Promise((_resolve, rejectOperation) => { reject = rejectOperation; }));
    act(() => renderer.root.findByProps({ "aria-label": "导入 desktop.example 配置 JSON" }).props.onClick());
    expect(renderer.root.findByProps({ "aria-label": "刷新插件列表" }).props.disabled).toBe(true);
    await act(async () => { reject(new Error("配置导入失败")); });
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["配置导入失败"]);
    expect(renderer.root.findByProps({ "aria-label": "刷新插件列表" }).props.disabled).toBe(false);
    plugins.list.mockResolvedValueOnce({ plugins: [], diagnostics: [] });
    await act(async () => { renderer.root.findByProps({ "aria-label": "刷新插件列表" }).props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("没有可管理的插件");
    act(() => renderer.unmount());
  });
});
