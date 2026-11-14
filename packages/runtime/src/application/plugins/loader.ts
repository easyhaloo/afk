import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, WorkflowPlugin } from './runtime.js';
import { PluginRuntime } from './runtime.js';
import { getConfiguredCredentialDependencies } from './configured.js';
import { readPluginConfiguration, validatePluginConfig, type InstalledPluginEntry } from './configuration.js';
import { PluginManager, readInstalledPlugin, resolveInstalledPluginEntry, type InstalledPluginRecord } from './manager.js';
import { validateManifest, validatePluginId, type PluginConfigValue } from '../../plugin-sdk/profile.js';

type LoadablePlugin = Plugin | WorkflowPlugin;
const pendingRecoveries = new WeakMap<PluginRuntime, Map<string, InstalledPluginRecord>>();

export type { InstalledPluginEntry } from './configuration.js';

export interface PluginFactoryOptions {
  readonly configuration: { readonly [key: string]: PluginConfigValue };
  readonly homeDir: string;
  readonly workspaceRoot: string;
}

export interface LoadInstalledPluginsOptions {
  readonly homeDir?: string;
  readonly resolveEntry?: (homeDir: string, pluginId: string) => string;
  readonly warn?: (message: string, error?: unknown) => void;
  readonly workspaceRoot?: string;
  readonly plugins?: readonly Plugin[];
  readonly entries?: readonly InstalledPluginEntry[];
}

function defaultResolveEntry(homeDir: string, pluginId: string): string {
  return join(homeDir, '.afk', 'plugins', pluginId, 'dist', 'index.js');
}

function isLoadablePlugin(value: unknown): value is LoadablePlugin {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkflowPlugin> & Partial<Plugin>;
  if (candidate.manifest && typeof candidate.manifest === 'object') {
    return typeof candidate.manifest.id === 'string' && typeof candidate.activate === 'function';
  }
  return typeof candidate.id === 'string' && typeof candidate.version === 'string' && typeof candidate.setup === 'function';
}

function pluginId(plugin: LoadablePlugin): string {
  return 'manifest' in plugin ? plugin.manifest.id : plugin.id;
}

export async function loadInstalledPlugins(
  runtime: PluginRuntime,
  options: LoadInstalledPluginsOptions = {},
): Promise<string[]> {
  const homeDir = options.homeDir ?? homedir();
  const resolveEntry = options.resolveEntry ?? defaultResolveEntry;
  const warn = options.warn ?? (() => undefined);
  let entries: readonly InstalledPluginEntry[];
  try { entries = options.entries ?? readPluginConfiguration(homeDir).plugins; }
  catch (error) {
    runtime.recordDiagnostic({ severity: 'error', code: 'config.invalid', message: error instanceof Error ? error.message : 'Invalid plugin configuration' });
    warn('Failed to read plugin configuration', error);
    entries = [];
  }
  const loaded: string[] = [];
  const seen = new Set<string>();
  const candidates: LoadablePlugin[] = [];
  const manager = new PluginManager({ homeDir });
  const activations = new Map<string, { record?: InstalledPluginRecord; entry?: InstalledPluginEntry; release: () => Promise<void> }>();
  const failed = (id: string, error: unknown, code = 'load.failed'): void => {
    warn(`Failed to load AFK plugin: ${id}`, error);
    runtime.recordDiagnostic({ pluginId: id, severity: 'error', code, message: error instanceof Error ? error.message : String(error) });
  };

  async function importCandidate(entry: InstalledPluginEntry): Promise<LoadablePlugin> {
    validatePluginId(entry.id);
    if (runtime.getPlugin(entry.id)) throw new Error(`Plugin '${entry.id}' already has an active runtime reference`);
    const directory = join(homeDir, '.afk', 'plugins', entry.id);
    const recovery = pendingRecoveries.get(runtime)?.get(entry.id);
    if (!options.resolveEntry && (recovery || runtime.hasPendingCleanup(entry.id))) {
      const record = recovery ?? await readInstalledPlugin(directory);
      if (runtime.hasPendingCleanup(entry.id)) await runtime.dispose(entry.id);
      if (record) await manager.restoreActivation(entry.id, record);
      pendingRecoveries.get(runtime)?.delete(entry.id);
    }
    const activation = options.resolveEntry ? undefined : await manager.beginActivation(entry.id);
    if (activation) activations.set(entry.id, activation);
    try {
      const record = activation?.record;
      // Recovery may have replaced this plugin's settings while acquiring its lease.
      if (record) entry = activation?.entry ?? entry;
      if (entry.enabled === false || entry.builtin) throw new Error('Plugin selection changed during activation');
      const modulePath = record ? await resolveInstalledPluginEntry(directory, record) : resolveEntry(homeDir, entry.id);
      if (!existsSync(modulePath)) {
        runtime.recordDiagnostic({ pluginId: entry.id, severity: 'warning', code: 'load.missing', message: `Plugin entry does not exist: ${modulePath}` });
        throw new Error(`Plugin entry does not exist: ${modulePath}`);
      }
      const module = await import(pathToFileURL(modulePath).href);
      const factory = module.default ?? module.plugin;
      const manifest = record?.manifest ?? module.manifest ?? (typeof factory === 'object' ? factory?.manifest : undefined);
      if (manifest) {
        validateManifest(manifest);
        validatePluginConfig(manifest.configSchema, entry.config ?? {});
      }
      const plugin = typeof factory === 'function'
        ? await factory({ configuration: entry.config ?? {}, homeDir, workspaceRoot: options.workspaceRoot ?? process.cwd() } satisfies PluginFactoryOptions)
        : factory;
      if (!isLoadablePlugin(plugin)) throw new Error('Plugin module does not export a supported plugin');
      if (pluginId(plugin) !== entry.id) throw new Error(`Plugin manifest id does not match '${entry.id}'`);
      if (record && (!('manifest' in plugin) || plugin.manifest.version !== record.version ||
        JSON.stringify([...plugin.manifest.provides].sort()) !== JSON.stringify([...record.manifest.provides].sort()))) {
        throw new Error('Installed plugin exports do not match its package manifest');
      }
      if ('manifest' in plugin) validatePluginConfig(plugin.manifest.configSchema, entry.config ?? {});
      return plugin;
    } catch (error) {
      await activation?.release();
      throw error;
    }
  }

  async function recover(id: string): Promise<LoadablePlugin | undefined> {
    const activation = activations.get(id);
    if (!activation) return undefined;
    if (runtime.hasPendingCleanup(id)) throw new Error(`Plugin '${id}' cleanup is unconfirmed; managed ownership and pending recovery retained`);
    await activation.release();
    if (!activation.record) return undefined;
    const restored = await manager.restoreActivation(id, activation.record);
    pendingRecoveries.get(runtime)?.delete(id);
    if (!restored) return undefined;
    runtime.recordDiagnostic({ pluginId: id, severity: 'warning', code: 'load.recovered', message: 'Failed upgrade restored the previous installed plugin; retrying its activation' });
    const entry = readPluginConfiguration(homeDir).plugins.find(candidate => candidate.id === id);
    if (!entry || entry.enabled === false || entry.builtin) return undefined;
    return importCandidate(entry);
  }

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      runtime.recordDiagnostic({ pluginId: entry.id, severity: 'warning', code: 'config.duplicate', message: `Duplicate plugin entry '${entry.id}' was ignored` });
      continue;
    }
    seen.add(entry.id);
    if (entry.enabled === false || entry.builtin) continue;
    try {
      candidates.push(await importCandidate(entry));
    } catch (error) {
      failed(entry.id, error);
      try { const previous = await recover(entry.id); if (previous) candidates.push(previous); }
      catch (recoveryError) { failed(entry.id, recoveryError, 'load.recovery-failed'); }
    }
  }

  const selected = new Map(candidates.map(plugin => [pluginId(plugin), plugin]));
  for (const plugin of options.plugins ?? []) {
    if (entries.some(entry => entry.id === plugin.manifest.id && entry.enabled === false)) continue;
    if (entries.some(entry => entry.id === plugin.manifest.id && !entry.builtin)) continue;
    if (!selected.has(plugin.manifest.id)) selected.set(plugin.manifest.id, plugin);
  }
  let pending = [...selected.values()];
  while (pending.length) {
    const deferred: LoadablePlugin[] = [];
    let progressed = false;
    for (const plugin of pending) {
      const requirements = 'manifest' in plugin ? plugin.manifest.requires ?? [] : [];
      if (requirements.some(capability => !runtime.listCapabilities().includes(capability))
        || getConfiguredCredentialDependencies(plugin).some(name => !runtime.getCredentialProvider(name))) { deferred.push(plugin); continue; }
      try {
        const activation = activations.get(pluginId(plugin));
        await runtime.load(plugin, activation?.release);
        if (activation?.record) await manager.confirmActivation(pluginId(plugin), activation.record, activation.entry);
        loaded.push(pluginId(plugin));
      } catch (error) {
        const id = pluginId(plugin);
        failed(id, error);
        const record = activations.get(id)?.record;
        if (record) {
          const recoveries = pendingRecoveries.get(runtime) ?? new Map<string, InstalledPluginRecord>();
          recoveries.set(id, record);
          pendingRecoveries.set(runtime, recoveries);
        }
        try {
          if (runtime.getPlugin(id)) await runtime.dispose(id);
          const previous = await recover(id);
          if (previous) deferred.push(previous);
        } catch (recoveryError) { failed(id, recoveryError, 'load.recovery-failed'); }
      }
      progressed = true;
    }
    if (!progressed) {
      const recovered: LoadablePlugin[] = [];
      for (const plugin of deferred) {
        const id = pluginId(plugin);
        runtime.recordDiagnostic({ pluginId: id, severity: 'error', code: 'load.dependencies', message: 'Plugin dependencies are missing or cyclic' });
        try {
          const previous = await recover(id);
          if (previous) recovered.push(previous);
        } catch (error) { failed(id, error, 'load.recovery-failed'); }
      }
      if (recovered.length) { pending = recovered; continue; }
      break;
    }
    pending = deferred;
  }

  return loaded;
}
