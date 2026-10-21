import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@afk/infrastructure';
import type { AgentExecution, ExecutionResult } from '../../domain/agents/types.js';
import {
  RuntimeLifecycle,
  type RuntimeLifecycleLabels,
  type RuntimeLifecycleStore,
  type RuntimeStartInput,
} from './runtime-lifecycle.js';
import type { TaskRuntimeRecord, TaskRuntimeRecordInput } from './task-runtime.js';

const LABELS: RuntimeLifecycleLabels = {
  publish: 'failed to publish workflow runtime',
  heartbeat: 'failed to update workflow runtime',
  archive: 'failed to archive workflow runtime',
  diagnostics: 'failed to persist workflow runtime diagnostics',
};

interface StoreCalls {
  start: TaskRuntimeRecordInput[];
  heartbeat: { runId: string; changes: unknown }[];
  finish: { runId: string; changes: { status?: string; progress?: string; errorSummary?: string } }[];
  writeDiagnostics: { runId: string; diagnostics: { result?: unknown; output?: string } }[];
  appendActivity: { runId: string; activity: { kind: string; message: string } }[];
}

function fakeStore(overrides: Partial<RuntimeLifecycleStore> = {}): { store: RuntimeLifecycleStore; calls: StoreCalls } {
  const calls: StoreCalls = { start: [], heartbeat: [], finish: [], writeDiagnostics: [], appendActivity: [] };
  const stored = { runId: 'run-1' } as unknown as TaskRuntimeRecord;
  const store: RuntimeLifecycleStore = {
    start: async record => { calls.start.push(record); },
    heartbeat: async (runId, changes) => { calls.heartbeat.push({ runId, changes }); return stored; },
    appendActivity: async (runId, activity) => { calls.appendActivity.push({ runId, activity }); return stored; },
    finish: async (runId, changes) => { calls.finish.push({ runId, changes }); return stored; },
    writeDiagnostics: async (runId, diagnostics) => { calls.writeDiagnostics.push({ runId, diagnostics }); return '/tmp/diagnostics'; },
    ...overrides,
  };
  return { store, calls };
}

function startInput(overrides: Partial<RuntimeStartInput> = {}): RuntimeStartInput {
  return {
    runId: 'run-1',
    phase: 'implementing',
    record: {
      backlogId: '42',
      workspace: '/w',
      providerRef: 'github:org/repo#42',
      title: 'Item',
      sandboxProvider: 'local',
      executionMode: 'batch',
      agentProvider: 'claude-code',
      session: 'session-1',
      branch: 'afk/backlog-42',
      progress: 'claimed',
    },
    ...overrides,
  };
}

function executionResult(status: ExecutionResult['status'], structuredOutput?: unknown): ExecutionResult {
  return { version: 1, runId: 'execution-1', status, provider: 'claude-code', commits: [], structuredOutput };
}

function fakeExecution(output = 'agent output'): AgentExecution {
  return {
    id: 'execution-1',
    metadata: { provider: 'claude-code', transport: 'process' },
    waitForResult: async () => executionResult('completed'),
    interrupt: async () => {},
    kill: async () => {},
    captureOutput: async () => output,
    captureSession: async () => undefined,
    resume: async () => fakeExecution(output),
  } as unknown as AgentExecution;
}

const DIAGNOSTICS = {
  failed: { kind: 'error' as const, message: 'acceptance verification failed' },
  completed: { kind: 'test' as const, message: 'acceptance verification completed' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime lifecycle', () => {
  it('publishes the record under the phase it was given, with the fields the caller supplied', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });

    await lifecycle.start(startInput());

    expect(calls.start).toHaveLength(1);
    expect(calls.start[0]).toMatchObject({
      runId: 'run-1',
      backlogId: '42',
      phase: 'implementing',
      status: 'running',
      workspace: '/w',
      providerRef: 'github:org/repo#42',
      title: 'Item',
      session: 'session-1',
      branch: 'afk/backlog-42',
      progress: 'claimed',
      sandboxProvider: 'local',
      executionMode: 'batch',
      agentProvider: 'claude-code',
    });
    expect(lifecycle.runId).toBe('run-1');
  });

  it('publishes the record of a run once', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });

    await lifecycle.start(startInput());
    await lifecycle.start(startInput({ runId: 'run-2' }));

    expect(calls.start).toHaveLength(1);
  });

  it('does not break the run when the record cannot be published', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { store } = fakeStore({
      start: async () => { throw new Error('store is down'); },
    });
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });

    await expect(lifecycle.start(startInput())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', backlogId: '42' }),
      'failed to publish workflow runtime',
    );
    // The run carries on without a record: there is nothing to heartbeat.
    expect(lifecycle.runId).toBeUndefined();
    await expect(lifecycle.heartbeat({ progress: 'running' })).resolves.toBeUndefined();
  });

  it('does not break the run when the heartbeat or the archive cannot be written', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { store } = fakeStore({
      heartbeat: async () => { throw new Error('store is down'); },
      finish: async () => { throw new Error('store is down'); },
    });
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await expect(lifecycle.heartbeat({ progress: 'running' })).resolves.toBeUndefined();
    await expect(lifecycle.finish({
      status: 'completed',
      progress: 'implementation handed to QA',
      defaultErrorSummary: 'workflow execution failed',
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      'failed to update workflow runtime',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      'failed to archive workflow runtime',
    );
  });

  it('records the default summary of a blocked run that has none of its own', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await lifecycle.finish({
      status: 'blocked',
      progress: 'implementation stopped',
      defaultErrorSummary: 'workflow execution failed',
    });

    expect(calls.finish).toHaveLength(1);
    expect(calls.finish[0].runId).toBe('run-1');
    expect(calls.finish[0].changes).toMatchObject({
      status: 'blocked',
      progress: 'implementation stopped',
      errorSummary: 'workflow execution failed',
    });
  });

  it('records the summary a blocked run gave of its own', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await lifecycle.finish({
      status: 'blocked',
      progress: 'workflow setup failed',
      errorSummary: 'workflow setup failed: template not found',
      defaultErrorSummary: 'workflow execution failed',
    });

    expect(calls.finish[0].changes.errorSummary).toBe('workflow setup failed: template not found');
  });

  it('records no summary of its own for a run that completed', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await lifecycle.finish({
      status: 'completed',
      progress: 'implementation handed to QA',
      errorSummary: 'not a failure',
      defaultErrorSummary: 'workflow execution failed',
    });

    expect(calls.finish[0].changes.errorSummary).toBeUndefined();
  });

  it('records a failed run as an error', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await lifecycle.diagnostics({
      result: executionResult('failed'),
      execution: fakeExecution(),
      ...DIAGNOSTICS,
    });

    expect(calls.writeDiagnostics[0].diagnostics.output).toBe('agent output');
    expect(calls.appendActivity[0].activity).toMatchObject({
      kind: 'error',
      message: 'acceptance verification failed',
    });
  });

  it('records a run that reported FAIL as an error', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await lifecycle.diagnostics({
      result: executionResult('completed', { result: 'FAIL' }),
      execution: fakeExecution(),
      ...DIAGNOSTICS,
    });

    expect(calls.appendActivity[0].activity.kind).toBe('error');
  });

  it('records a run that passed under the kind the runner names it with', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await lifecycle.diagnostics({
      result: executionResult('completed', { result: 'PASS' }),
      execution: fakeExecution(),
      ...DIAGNOSTICS,
    });

    expect(calls.appendActivity[0].activity).toMatchObject({
      kind: 'test',
      message: 'acceptance verification completed',
    });
  });

  it('records the summary the run reported rather than its own wording', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    await lifecycle.diagnostics({
      result: executionResult('completed', { result: 'PASS', summary: 'all criteria met' }),
      execution: fakeExecution(),
      ...DIAGNOSTICS,
    });

    expect(calls.appendActivity[0].activity.message).toBe('all criteria met');
  });

  it('does not heartbeat a run that has not started', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });

    await lifecycle.heartbeat({ progress: 'running' });

    expect(calls.heartbeat).toHaveLength(0);
  });

  it('does not heartbeat a run that has finished', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());
    await lifecycle.finish({
      status: 'completed',
      progress: 'implementation handed to QA',
      defaultErrorSummary: 'workflow execution failed',
    });

    await lifecycle.heartbeat({ progress: 'running' });

    expect(calls.heartbeat).toHaveLength(0);
  });

  it('has nothing to archive for a run that never published a record', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });

    await lifecycle.finish({
      status: 'blocked',
      progress: 'implementation stopped',
      defaultErrorSummary: 'workflow execution failed',
    });

    expect(calls.finish).toHaveLength(0);
  });

  it('starts a new run from nothing after a reset', async () => {
    const { store, calls } = fakeStore();
    const lifecycle = new RuntimeLifecycle({ store, labels: LABELS });
    await lifecycle.start(startInput());

    lifecycle.reset();

    expect(lifecycle.runId).toBeUndefined();
    await lifecycle.start(startInput({ runId: 'run-2' }));
    expect(calls.start).toHaveLength(2);
    expect(calls.start[1].runId).toBe('run-2');
  });
});
