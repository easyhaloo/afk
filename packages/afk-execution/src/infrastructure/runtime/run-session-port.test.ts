import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AfkResourceRecord } from '@afk/core';
import { createRunSessionPort } from './run-session-port.js';

function tmuxRecord(worktreePath: string, name: string): AfkResourceRecord {
  return {
    id: 'resource-1',
    resourceKey: `key:${name}`,
    workspacePath: '/repo',
    runId: 'run-1',
    worktreePath,
    kind: 'tmux',
    origin: 'local-sandbox',
    name,
    status: 'active',
    metadata: {},
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
}

describe('stopping a run', () => {
  it('stops the run\'s own session and says why', async () => {
    // A run's agent is a process in a terminal session. Stopping the run
    // has to stop that process, and the run has to be able to say that a
    // person asked for it rather than reporting a crash.
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-run-stop-'));
    const killed: string[] = [];
    const port = createRunSessionPort(
      { readActive: () => [], readRun: () => [tmuxRecord(worktreePath, 'afk-github_acme/api#42')] },
      {
        hasSession: async () => true,
        killSession: async name => { killed.push(name); },
      },
    );

    await expect(port.stop('run-1')).resolves.toBe(true);

    expect(killed).toEqual(['afk-github_acme/api#42']);
    const request = JSON.parse(await readFile(join(worktreePath, '.afk-interrupt.json'), 'utf8'));
    expect(request.reason).toBe('manual');
  });

  it('leaves a run that registered no session alone', async () => {
    const killed: string[] = [];
    const port = createRunSessionPort(
      { readActive: () => [], readRun: () => [] },
      { hasSession: async () => true, killSession: async name => { killed.push(name); } },
    );

    await expect(port.stop('run-1')).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  it('leaves a session that is already gone alone', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-run-stop-'));
    const killed: string[] = [];
    const port = createRunSessionPort(
      { readActive: () => [], readRun: () => [tmuxRecord(worktreePath, 'afk-gone')] },
      { hasSession: async () => false, killSession: async name => { killed.push(name); } },
    );

    await expect(port.stop('run-1')).resolves.toBe(false);
    expect(killed).toEqual([]);
  });
});
