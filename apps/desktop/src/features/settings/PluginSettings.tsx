import { useEffect, useRef, useState } from "react";
import { FileJson, FolderOpen, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import type { DesktopPluginList } from "../../../shared/plugin-contract.js";
import { SshConfirmDialog } from "../ssh/SshConfirmDialog.js";
import "./plugins.css";

export function PluginSettings() {
  const [inventory, setInventory] = useState<DesktopPluginList>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [spec, setSpec] = useState("");
  const [removing, setRemoving] = useState<string>();
  const inFlight = useRef(false);
  const mounted = useRef(false);

  async function run(operation?: () => Promise<boolean>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const changed = operation ? await operation() : false;
      if (changed && mounted.current) setMessage("已保存，对后续运行生效；正在运行的 Worker 保持原配置。管理检查快照在重启应用后更新。");
      const result = await window.afkDesktop.plugins.list();
      if (mounted.current) setInventory(result);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "插件操作失败");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => { mounted.current = false; };
  }, []);

  const configInvalid = inventory?.diagnostics.some(diagnostic => diagnostic.code === "config.invalid");
  return <section className="settings-section plugin-settings" aria-label="插件管理" aria-busy={busy}>
    <header><div><b>插件管理</b><small>运行时检查与已安装插件。启停和配置对后续运行生效，不热更新正在运行的 Worker。</small></div><div className="plugin-actions">
      <button type="button" aria-label="刷新插件列表" title="刷新安装状态；运行时检查快照在重启后更新" disabled={busy} onClick={() => void run()}><RefreshCw size={16} /></button>
      <button type="button" aria-label="安装插件" title="安装插件" disabled={busy || !inventory || configInvalid} aria-expanded={installOpen} onClick={() => setInstallOpen(!installOpen)}><Plus size={16} /></button>
    </div></header>
    <p className="plugin-notice">检查快照不代表各 Worker 的实时状态。安装与卸载需等待活动 Worker 结束。仅安装可信插件；插件代码可在后续运行中访问本机资源。</p>
    {installOpen ? <form className="plugin-install" onSubmit={event => { event.preventDefault(); void run(() => window.afkDesktop.plugins.install({ kind: "npm", spec: spec.trim() })); }}>
      <label>npm 插件包<input aria-label="npm 插件包" value={spec} onChange={event => setSpec(event.target.value)} placeholder="@scope/plugin@1.0.0" disabled={busy} /></label>
      <button type="submit" disabled={busy || !spec.trim()}>从 npm 安装</button>
      <button type="button" disabled={busy} onClick={() => void run(() => window.afkDesktop.plugins.install({ kind: "local" }))}><FolderOpen size={16} aria-hidden="true" />选择本地目录</button>
    </form> : null}
    {error ? <p role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!inventory ? <p role="status">{busy ? "正在读取插件…" : "未能读取插件，请刷新重试。"}</p> : null}
    {inventory?.plugins.length === 0 ? <p>没有可管理的插件。</p> : null}
    <ul className="plugin-list">{inventory?.plugins.map(plugin => <li key={plugin.id}>
      <div className="plugin-description"><b>{plugin.id}</b><small>{plugin.version ?? "版本未知"} · {({ builtin: "内置", installed: "已安装", configured: "仅配置记录" })[plugin.origin]} · 后续运行：{plugin.enabled ? "启用" : "禁用"} · 检查快照：{plugin.runtimeLoaded ? "已加载" : "未加载"}</small>
        <small>{plugin.capabilities.join(" · ") || "未声明能力"}</small>
      </div><div className="plugin-actions">
        <button type="button" aria-label={`${plugin.enabled ? "禁用" : "启用"} ${plugin.id}`} title={plugin.enabled ? "禁用插件" : "启用插件"} aria-pressed={plugin.enabled} disabled={busy || configInvalid || (!plugin.enabled && plugin.origin === "configured")} onClick={() => void run(() => window.afkDesktop.plugins.setEnabled(plugin.id, !plugin.enabled))}><Power size={16} /></button>
        {plugin.configurable ? <button type="button" aria-label={`导入 ${plugin.id} 配置 JSON`} title="从本机 JSON 文件替换配置；现有配置值不会传入界面" disabled={busy} onClick={() => void run(() => window.afkDesktop.plugins.configure(plugin.id))}><FileJson size={16} /></button> : null}
        {plugin.removable ? <button type="button" aria-label={`卸载 ${plugin.id}`} title="卸载插件并保留配置" disabled={busy || configInvalid} onClick={() => setRemoving(plugin.id)}><Trash2 size={16} /></button> : null}
      </div>
    </li>)}</ul>
    {inventory?.diagnostics.length ? <ul className="plugin-diagnostics" aria-label="插件诊断">{inventory.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.pluginId}-${diagnostic.code}-${index}`}><b>{diagnostic.severity} · {diagnostic.pluginId ?? "运行时"} · {diagnostic.code}</b><span>{diagnostic.message}</span></li>)}</ul> : null}
    <p className="plugin-notice">配置：在本机编辑 JSON 对象文件后导入，以替换插件设置；推荐使用环境变量引用保存密钥。此入口不加载 surface.desktop 扩展界面。</p>
    {removing ? <SshConfirmDialog title="卸载插件" description={`卸载 ${removing}，保留配置。仅对后续运行生效；有活动 Worker 时会阻止卸载。`} confirmLabel="卸载" confirmAriaLabel="确认卸载插件" onCancel={() => setRemoving(undefined)} onConfirm={() => { const id = removing; setRemoving(undefined); void run(() => window.afkDesktop.plugins.remove(id)); }} /> : null}
  </section>;
}
