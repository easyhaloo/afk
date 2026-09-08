import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { fileLogger } from '../../infrastructure/io/index';
import type { LoadedTuiView, TuiPlugin } from './types';
import { isTuiPlugin } from './types';

interface PluginConfigEntry {
  id: string;
  enabled?: boolean;
}

export interface LoadTuiViewsOptions {
  homeDir?: string;
  resolveEntry?: (homeDir: string, pluginId: string) => string;
  warn?: (message: string, error?: unknown) => void;
}

const BUILTIN_SHORTCUTS = new Set(['1', '2', '3', '4', 'a', 'A', 'b', 'g', 'G', 'o', 'q', 'r', '/', '?']);

function defaultResolveEntry(homeDir: string, pluginId: string): string {
  return join(homeDir, '.afk', 'plugins', pluginId, 'dist', 'index.js');
}

function readPluginConfig(path: string, warn: (message: string, error?: unknown) => void): PluginConfigEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = load(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { plugins?: unknown }).plugins)) return [];
    return (parsed as { plugins: unknown[] }).plugins.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as { id?: unknown; enabled?: unknown };
      if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(candidate.id)) return [];
      return [{ id: candidate.id.trim(), enabled: candidate.enabled === false ? false : true }];
    });
  } catch (error) {
    warn(`Failed to parse TUI plugin configuration: ${path}`, error);
    return [];
  }
}

async function importPlugin(
  pluginId: string,
  homeDir: string,
  resolveEntry: (homeDir: string, pluginId: string) => string,
  warn: (message: string, error?: unknown) => void,
): Promise<TuiPlugin | null> {
  const entry = resolveEntry(homeDir, pluginId);
  if (!existsSync(entry)) {
    warn(`Skipping missing TUI plugin entry: ${pluginId}`);
    return null;
  }
  try {
    const module = await import(pathToFileURL(entry).href);
    const candidate = module.default ?? module.plugin;
    if (!isTuiPlugin(candidate)) {
      warn(`Skipping malformed TUI plugin: ${pluginId}`);
      return null;
    }
    if (candidate.id !== pluginId) {
      warn(`Skipping TUI plugin with mismatched id: ${pluginId}`);
      return null;
    }
    return candidate;
  } catch (error) {
    warn(`Failed to load TUI plugin: ${pluginId}`, error);
    return null;
  }
}

export async function loadTuiViews(options: LoadTuiViewsOptions = {}): Promise<LoadedTuiView[]> {
  const homeDir = options.homeDir ?? homedir();
  const resolveEntry = options.resolveEntry ?? defaultResolveEntry;
  const warn = options.warn ?? ((message, error) => fileLogger.warn({ err: error }, message));
  const entries = readPluginConfig(join(homeDir, '.afk', 'plugins.yml'), warn);
  const accepted: LoadedTuiView[] = [];
  const usedIds = new Set<string>(['tasks', 'backlogs', 'projects', 'board']);
  const usedShortcuts = new Set(BUILTIN_SHORTCUTS);
  const seenPlugins = new Set<string>();

  for (const entry of entries) {
    if (seenPlugins.has(entry.id)) continue;
    seenPlugins.add(entry.id);
    if (entry.enabled === false) continue;
    const plugin = await importPlugin(entry.id, homeDir, resolveEntry, warn);
    if (!plugin) continue;

    for (const view of plugin.views) {
      const id = `plugin:${plugin.id}:${view.id}` as LoadedTuiView['id'];
      const shortcut = view.shortcut.trim();
      if (usedIds.has(id)) {
        warn(`Skipping duplicate TUI plugin view: ${id}`);
        continue;
      }
      if (usedShortcuts.has(shortcut)) {
        warn(`Skipping conflicting TUI plugin shortcut: ${plugin.id}:${view.id}`);
        continue;
      }
      usedIds.add(id);
      usedShortcuts.add(shortcut);
      accepted.push({
        id,
        pluginId: plugin.id,
        title: view.title.trim(),
        shortcut,
        render: view.render,
      });
    }
  }

  return accepted;
}
