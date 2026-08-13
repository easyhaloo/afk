import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { load } from 'js-yaml';
import type { Plugin, PluginManifest } from './types';
import type { View } from '../../views/ui/core/types';

const PLUGINS_CONFIG = path.join(os.homedir(), '.afk', 'plugins.yml');

interface PluginsConfig {
  plugins: Array<{
    id: string;
    enabled?: boolean;
  }>;
}

function parseYaml(raw: string): PluginsConfig {
  const content = raw.replace(/!!null\b\s*/g, '');
  try {
    return load(content) as PluginsConfig;
  } catch {
    return { plugins: [] };
  }
}

export function loadPluginRegistry(): Array<{ id: string; enabled: boolean }> {
  try {
    if (!fs.existsSync(PLUGINS_CONFIG)) {
      return [];
    }
    const raw = fs.readFileSync(PLUGINS_CONFIG, 'utf-8');
    const config = parseYaml(raw);
    return (config.plugins || []).map(p => ({
      id: p.id,
      enabled: p.enabled !== false,
    }));
  } catch {
    return [];
  }
}

export async function loadPlugin(id: string, mainPath: string): Promise<Plugin | null> {
  try {
    const resolved = await import(mainPath);
    const mod = resolved.default ?? resolved;
    if (!mod.id || !mod.views) return null;
    return mod as Plugin;
  } catch {
    return null;
  }
}

export async function loadAllPlugins(): Promise<View[]> {
  const registry = loadPluginRegistry();
  const enabledPlugins = registry.filter(p => p.enabled);
  if (enabledPlugins.length === 0) return [];

  const views: View[] = [];
  for (const { id } of enabledPlugins) {
    const mainPath = path.join(os.homedir(), '.afk', 'plugins', id, 'dist', 'index.js');
    const plugin = await loadPlugin(id, mainPath);
    if (plugin) {
      views.push(...plugin.views);
    }
  }
  return views;
}
