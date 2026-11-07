import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, WorkflowPlugin } from './runtime.js';
import { PluginRuntime } from './runtime.js';
import { getConfiguredCredentialDependencies } from './configured.js';
import { readPluginConfiguration, validatePluginConfig, type InstalledPluginEntry } from './configuration.js';
import { readInstalledPlugin, resolveInstalledPluginEntry } from './manager.js';
import { validateManifest, type PluginConfigValue } from '../../plugin-sdk/profile.js';

type LoadablePlugin = Plugin | WorkflowPlugin;

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

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      runtime.recordDiagnostic({ pluginId: entry.id, severity: 'warning', code: 'config.duplicate', message: `Duplicate plugin entry '${entry.id}' was ignored` });
      continue;
    }
    seen.add(entry.id);
    if (entry.enabled === false || entry.builtin) continue;
    try {
      const directory = join(homeDir, '.afk', 'plugins', entry.id);
      const record = options.resolveEntry ? undefined : await readInstalledPlugin(directory);
      const modulePath = record ? await resolveInstalledPluginEntry(directory, record) : resolveEntry(homeDir, entry.id);
      if (!existsSync(modulePath)) {
        warn(`Skipping missing plugin entry: ${entry.id}`);
        runtime.recordDiagnostic({ pluginId: entry.id, severity: 'warning', code: 'load.missing', message: `Plugin entry does not exist: ${modulePath}` });
        continue;
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
      if (!isLoadablePlugin(plugin)) {
        warn(`Skipping malformed AFK plugin: ${entry.id}`);
        runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'load.malformed', message: 'Plugin module does not export a supported plugin' });
        continue;
      }
      if (pluginId(plugin) !== entry.id) {
        warn(`Skipping AFK plugin with mismatched id: ${entry.id}`);
        runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'load.id-mismatch', message: `Plugin manifest id does not match '${entry.id}'` });
        continue;
      }
      if (record && (!('manifest' in plugin) || plugin.manifest.version !== record.version ||
        JSON.stringify([...plugin.manifest.provides].sort()) !== JSON.stringify([...record.manifest.provides].sort()))) {
        throw new Error('Installed plugin exports do not match its package manifest');
      }
      if ('manifest' in plugin) validatePluginConfig(plugin.manifest.configSchema, entry.config ?? {});
      candidates.push(plugin);
    } catch (error) {
      warn(`Failed to load AFK plugin: ${entry.id}`, error);
      runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'load.failed', message: error instanceof Error ? error.message : String(error) });
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
        await runtime.load(plugin);
        loaded.push(pluginId(plugin));
      } catch (error) {
        runtime.recordDiagnostic({ pluginId: pluginId(plugin), severity: 'error', code: 'load.failed', message: error instanceof Error ? error.message : 'Plugin activation failed' });
      }
      progressed = true;
    }
    if (!progressed) {
      for (const plugin of deferred) runtime.recordDiagnostic({ pluginId: pluginId(plugin), severity: 'error', code: 'load.dependencies', message: 'Plugin dependencies are missing or cyclic' });
      break;
    }
    pending = deferred;
  }

  return loaded;
}
