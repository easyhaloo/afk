import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadTuiViews } from './loader';
import { isTuiPlugin } from './types';

function makePluginHome(input: { config: string; plugins: Record<string, string> }): string {
  const root = mkdtempSync(join(tmpdir(), 'afk-tui-plugin-'));
  const configDir = join(root, '.afk');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'plugins.yml'), input.config);
  for (const [id, source] of Object.entries(input.plugins)) {
    const distDir = join(configDir, 'plugins', id, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), source);
  }
  return root;
}

const fixtureEntry = (homeDir: string, pluginId: string) => join(homeDir, '.afk', 'plugins', pluginId, 'dist', 'index.mjs');

describe('TUI plugin contract', () => {
  it('accepts valid plugin metadata and views', () => {
    const validPlugin = {
      id: 'example',
      name: 'Example',
      views: [{ id: 'status', title: 'Status', shortcut: 'z', render: () => null }],
    };

    expect(isTuiPlugin(validPlugin)).toBe(true);
    expect(isTuiPlugin({ id: 'example', name: 'Example', views: [] })).toBe(true);
  });

  it('rejects malformed plugin metadata and views', () => {
    expect(isTuiPlugin({ id: '', name: 'Example', views: [] })).toBe(false);
    expect(isTuiPlugin({ id: 'example', name: 'Example', views: [{ id: 'status' }] })).toBe(false);
    expect(isTuiPlugin({ id: 'example', name: 'Example', views: 'status' })).toBe(false);
    expect(isTuiPlugin(null)).toBe(false);
  });

  it('loads enabled plugins and namespaces their views', async () => {
    const root = makePluginHome({
      config: 'plugins:\n  - id: enabled\n    enabled: true\n  - id: disabled\n    enabled: false\n',
      plugins: {
        enabled: `export default { id: 'enabled', name: 'Enabled', views: [{ id: 'status', title: 'Status', shortcut: 'z', render: () => null }] }`,
        disabled: `export default { id: 'disabled', name: 'Disabled', views: [] }`,
      },
    });
    try {
      await expect(loadTuiViews({ homeDir: root, resolveEntry: fixtureEntry })).resolves.toMatchObject([
        { id: 'plugin:enabled:status', pluginId: 'enabled', shortcut: 'z' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts named exports and skips malformed or missing plugins', async () => {
    const root = makePluginHome({
      config: 'plugins:\n  - id: named\n  - id: malformed\n  - id: missing\n',
      plugins: {
        named: `export const plugin = { id: 'named', name: 'Named', views: [{ id: 'status', title: 'Status', shortcut: 'y', render: () => null }] }`,
        malformed: `export default { id: 'malformed' }`,
      },
    });
    const warn = vi.fn();
    try {
      await expect(loadTuiViews({ homeDir: root, resolveEntry: fixtureEntry, warn })).resolves.toMatchObject([
        { id: 'plugin:named:status' },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps built-in shortcuts and first plugin views ahead of conflicts', async () => {
    const root = makePluginHome({
      config: 'plugins:\n  - id: first\n  - id: first\n  - id: second\n',
      plugins: {
        first: `export default { id: 'first', name: 'First', views: [{ id: 'one', title: 'One', shortcut: 'z', render: () => null }, { id: 'two', title: 'Two', shortcut: 'z', render: () => null }, { id: 'built-in', title: 'Built-in', shortcut: '1', render: () => null }] }`,
        second: `export default { id: 'second', name: 'Second', views: [{ id: 'one', title: 'One', shortcut: 'y', render: () => null }] }`,
      },
    });
    try {
      await expect(loadTuiViews({ homeDir: root, resolveEntry: fixtureEntry })).resolves.toMatchObject([
        { id: 'plugin:first:one', shortcut: 'z' },
        { id: 'plugin:second:one', shortcut: 'y' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
