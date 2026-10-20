import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusFilePath } from '@afk/infrastructure';
import { agentReadiness } from './agent-readiness.js';

describe('agent readiness', () => {
  it('waits for the statusline Claude Code writes on its first turn', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'afk-readiness-'));
    try {
      const readiness = agentReadiness('claude-code');
      await mkdir(join(worktree, '.afk'), { recursive: true });
      await expect(readiness.ready({ worktreeDir: worktree, sessionExists: async () => true })).resolves.toBe(false);
      await writeFile(statusFilePath(worktree), '{}');
      await expect(readiness.ready({ worktreeDir: worktree, sessionExists: async () => true })).resolves.toBe(true);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('waits for the session for the agents that write no marker', async () => {
    const readiness = agentReadiness('codex');
    const absent = vi.fn(async () => false);
    const present = vi.fn(async () => true);

    await expect(readiness.ready({ worktreeDir: '/missing', session: 'codex-session', sessionExists: absent })).resolves.toBe(false);
    await expect(readiness.ready({ worktreeDir: '/missing', session: 'codex-session', sessionExists: present })).resolves.toBe(true);
    // With no session there is nothing to wait for.
    await expect(readiness.ready({ worktreeDir: '/missing', sessionExists: absent })).resolves.toBe(true);
  });

  it('names the agent the rule is about', () => {
    expect(agentReadiness('claude-code').agent).toBe('claude-code');
    expect(agentReadiness('cursor').agent).toBe('cursor');
  });
});
