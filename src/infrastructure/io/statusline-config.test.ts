import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { configureStatusline } from './statusline-config';

describe('configureStatusline', () => {
  it('preserves tracked project settings and writes an idempotent local override', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'afk-statusline-'));
    const claudeDir = join(worktree, '.claude');
    const trackedSettings = join(claudeDir, 'settings.json');
    const localSettings = join(claudeDir, 'settings.local.json');
    const original = '{\n  "permissions": { "allow": ["Bash(git status)"] }\n}\n';
    await mkdir(claudeDir);
    await writeFile(trackedSettings, original);

    await configureStatusline(worktree);
    await configureStatusline(worktree);

    expect(await readFile(trackedSettings, 'utf8')).toBe(original);
    const local = await readFile(localSettings, 'utf8');
    expect(local).toContain(join(worktree, '.afk', 'claude-status.json'));
    expect(local.match(/claude-status\.json/g)).toHaveLength(1);
  });
});
