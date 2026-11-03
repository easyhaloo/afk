import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  claudeProjectKeys,
  isClaudeCodeArgv,
  preacceptClaudeProjectTrust,
  resolveClaudeConfigFilePath,
} from './claude-trust.js';

type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue };

async function readConfig(path: string): Promise<{ [key: string]: ConfigValue }> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parsed as { [key: string]: ConfigValue };
}

function projectsOf(config: { [key: string]: ConfigValue }): { [key: string]: { [key: string]: ConfigValue } } {
  const projects = config.projects;
  return projects && typeof projects === 'object' && !Array.isArray(projects)
    ? (projects as { [key: string]: { [key: string]: ConfigValue } })
    : {};
}

describe('resolveClaudeConfigFilePath', () => {
  it('defaults to the user home config file', () => {
    expect(resolveClaudeConfigFilePath({}).endsWith('/.claude.json')).toBe(true);
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    expect(resolveClaudeConfigFilePath({ CLAUDE_CONFIG_DIR: '/tmp/afk-claude-config' }))
      .toBe('/tmp/afk-claude-config/.claude.json');
  });
});

describe('isClaudeCodeArgv', () => {
  it('matches the claude binary and rejects other agents', () => {
    expect(isClaudeCodeArgv(['claude', '--dangerously-skip-permissions'])).toBe(true);
    expect(isClaudeCodeArgv(['/usr/local/bin/claude'])).toBe(true);
    expect(isClaudeCodeArgv(['C:\\tools\\claude.exe'])).toBe(true);
    expect(isClaudeCodeArgv(['codex'])).toBe(false);
    expect(isClaudeCodeArgv([])).toBe(false);
  });
});

describe('claudeProjectKeys', () => {
  it('returns the absolute path of the worktree', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'afk-claude-trust-'));
    expect(claudeProjectKeys(worktree)).toContain(worktree);
  });
});

describe('preacceptClaudeProjectTrust', () => {
  it('creates the trust entry for a fresh worktree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afk-claude-trust-'));
    const worktree = join(dir, 'worktree');
    await mkdir(worktree);
    const configFilePath = join(dir, '.claude.json');

    const result = await preacceptClaudeProjectTrust(worktree, { configFilePath, env: {} });

    expect(result.trusted).toBe(true);
    expect(result.wrote).toBe(true);
    const projects = projectsOf(await readConfig(configFilePath));
    expect(projects[worktree].hasTrustDialogAccepted).toBe(true);
  });

  it('is idempotent and preserves unrelated state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afk-claude-trust-'));
    const worktree = join(dir, 'worktree');
    await mkdir(worktree);
    const configFilePath = join(dir, '.claude.json');
    await writeFile(
      configFilePath,
      JSON.stringify({
        numStartups: 7,
        projects: { '/other/project': { allowedTools: ['Bash'] } },
      }),
    );

    await preacceptClaudeProjectTrust(worktree, { configFilePath, env: {} });
    const second = await preacceptClaudeProjectTrust(worktree, { configFilePath, env: {} });

    expect(second.trusted).toBe(true);
    expect(second.wrote).toBe(false);
    const config = await readConfig(configFilePath);
    expect(config.numStartups).toBe(7);
    const projects = projectsOf(config);
    expect(projects['/other/project'].allowedTools).toEqual(['Bash']);
    expect(projects['/other/project'].hasTrustDialogAccepted).toBeUndefined();
    expect(projects[worktree].hasTrustDialogAccepted).toBe(true);
  });

  it('never clobbers a malformed config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afk-claude-trust-'));
    const configFilePath = join(dir, '.claude.json');
    await writeFile(configFilePath, '{ not json');

    const result = await preacceptClaudeProjectTrust(dir, { configFilePath, env: {} });

    expect(result.trusted).toBe(false);
    expect(await readFile(configFilePath, 'utf8')).toBe('{ not json');
  });

  it('does nothing when the pre-accept is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afk-claude-trust-'));
    const configFilePath = join(dir, '.claude.json');

    const result = await preacceptClaudeProjectTrust(dir, {
      configFilePath,
      env: { AFK_CLAUDE_TRUST_PRESEED: '0' },
    });

    expect(result.trusted).toBe(false);
    expect(result.wrote).toBe(false);
    await expect(readFile(configFilePath, 'utf8')).rejects.toThrow();
  });
});
