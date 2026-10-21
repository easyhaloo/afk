import { describe, expect, it } from 'vitest';
import { matchesRuntimeRecord } from './task-runtime.js';
import type { TaskRuntimeRecord } from '@afk/core';

function record(overrides: Partial<TaskRuntimeRecord> = {}): TaskRuntimeRecord {
  return {
    runId: 'run-1', backlogId: '42', phase: 'implementing', status: 'running',
    sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
    startedAt: '2026-10-20T00:00:00.000Z', heartbeatAt: '2026-10-20T00:00:01.000Z',
    ...overrides,
  };
}

describe('runtime record identity', () => {
  it('matches on the provider-qualified work item id', () => {
    expect(matchesRuntimeRecord(record({ providerRef: 'github:org/repo#42' }), { workItemId: 'github:org/repo#42' })).toBe(true);
    expect(matchesRuntimeRecord(record({ providerRef: 'github:other/repo#42' }), { workItemId: 'github:org/repo#42' })).toBe(false);
  });

  it('matches on the provider backlog id', () => {
    expect(matchesRuntimeRecord(record({ backlogId: '42' }), { backlogId: '42' })).toBe(true);
    expect(matchesRuntimeRecord(record({ backlogId: '43' }), { backlogId: '42' })).toBe(false);
  });

  it('requires the workspace when the caller knows one', () => {
    expect(matchesRuntimeRecord(record({ workspace: '/w' }), { workspace: '/w' })).toBe(true);
    expect(matchesRuntimeRecord(record({ workspace: '/other' }), { workspace: '/w' })).toBe(false);
  });

  it('accepts a record that only names a worktree inside the workspace', () => {
    expect(matchesRuntimeRecord(record({ worktree: '/w/.afk/worktree' }), { workspace: '/w' })).toBe(true);
    expect(matchesRuntimeRecord(record({ worktree: '/elsewhere' }), { workspace: '/w' })).toBe(false);
  });

  it('rejects a record that cannot be placed in the workspace', () => {
    expect(matchesRuntimeRecord(record(), { workspace: '/w' })).toBe(false);
  });

  it('accepts a record when the caller knows no identity', () => {
    expect(matchesRuntimeRecord(record(), {})).toBe(true);
  });
});
