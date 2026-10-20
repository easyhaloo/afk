import { describe, expect, it } from 'vitest';
import { runtimeRecord } from './runtime-record.js';

describe('runtime record', () => {
  it('carries the fields a reader needs, whatever the phase', () => {
    const record = runtimeRecord({
      runId: 'run-1', backlogId: '42', workspace: '/w', providerRef: 'github:org/repo#42',
      title: 'Item', phase: 'verifying', progress: 'QA starting',
      sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
      branch: 'afk/backlog-42', now: '2026-10-20T00:00:00.000Z',
    });
    expect(record).toMatchObject({
      runId: 'run-1', backlogId: '42', workspace: '/w', providerRef: 'github:org/repo#42',
      title: 'Item', phase: 'verifying', status: 'running', progress: 'QA starting',
      sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
      branch: 'afk/backlog-42',
      startedAt: '2026-10-20T00:00:00.000Z', heartbeatAt: '2026-10-20T00:00:00.000Z',
    });
  });

  it('leaves out what a phase does not have', () => {
    const record = runtimeRecord({
      runId: 'run-1', backlogId: '42', phase: 'implementing', progress: 'claimed',
      sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
    });
    expect(record.session).toBeUndefined();
    expect(record.branch).toBeUndefined();
    expect(record.workspace).toBeUndefined();
  });
});
