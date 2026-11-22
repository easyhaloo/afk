import { workspaceDataDirectory } from '../workspace.js';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { configureStatusline } from './statusline-config.js';
import { claudeStatuslineSettingsPath } from '../../shared/workspace-paths.js';

describe('configureStatusline', () => {
  it('keeps checkout settings intact and writes an idempotent statusline-only overlay', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'afk-statusline-'));
    const claudeDir = join(worktree, '.claude');
    const trackedSettings = join(claudeDir, 'settings.json');
    const localSettings = join(claudeDir, 'settings.local.json');
    const original = '{\n  "permissions": { "allow": ["Bash(git status)"] }\n}\n';
    await mkdir(claudeDir);
    await writeFile(trackedSettings, original);
    const userSettings = '{"permissions":{"deny":["Write"]},"statusLine":{"command":"my-status"}}\n';
    await writeFile(localSettings, userSettings);

    await configureStatusline(worktree);
    await configureStatusline(worktree);

    expect(await readFile(trackedSettings, 'utf8')).toBe(original);
    expect(await readFile(localSettings, 'utf8')).toBe(userSettings);
    const local = await readFile(claudeStatuslineSettingsPath(worktree), 'utf8');
    expect(Object.keys(JSON.parse(local))).toEqual(['statusLine']);
    expect(local).toContain('my-status');
    expect(local).toContain(join(workspaceDataDirectory(worktree), 'claude-status.json'));
    expect(local.match(/claude-status\.json/g)).toHaveLength(1);
  });
});
