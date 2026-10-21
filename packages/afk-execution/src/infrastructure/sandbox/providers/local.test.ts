import { access, mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { SignalSchema } from '@afk/infrastructure';
import { LocalAgentExecution, LocalSandboxProvider } from './local.js';

// The resource registry is a user-global file under the home directory. A
// test must not write to it: it would both pollute the machine and contend
// with anything else that has the file open.
vi.mock('../../runtime/resource-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/resource-registry.js')>();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'afk-resource-registry-'));
  let registry: InstanceType<typeof actual.AfkResourceRegistry> | undefined;
  return {
    ...actual,
    getAfkResourceRegistry: () => (registry ??= new actual.AfkResourceRegistry({ databasePath: join(root, 'resources.sqlite') })),
  };
});

describe('LocalSandboxProvider', () => {
  const metadata = { provider: 'claude-code', transport: 'process' } as const;
  it('provisions a batch sandbox without creating a tmux session', async () => {
    const tmux = { createSession: vi.fn(), waitForPrompt: vi.fn() };
    const provider = new LocalSandboxProvider();

    await provider.create({
      worktreePath: process.cwd(),
      session: 'batch-test',
      executionMode: 'batch',
      tmux: tmux as never,
    });

    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.waitForPrompt).not.toHaveBeenCalled();
  });

  it('starts interactive work with the provider-built command and tmux prompt', async () => {
    const tmux = {
      createSession: vi.fn(async () => ({})),
      sendPrompt: vi.fn(async () => {}),
      killSession: vi.fn(async () => {}),
      closeSession: vi.fn(),
    };
    const provider = new LocalSandboxProvider();
    const sandbox = await provider.create({
      worktreePath: process.cwd(),
      session: 'interactive-test',
      executionMode: 'interactive',
      tmux: tmux as never,
    });

    await sandbox.startAgent({
      command: { argv: ['agent', '--interactive'], cwd: process.cwd() },
      prompt: 'goal',
      generation: 1,
      signalType: 'goal_complete',
      executionMode: 'interactive',
      metadata,
    });

    expect(tmux.createSession).toHaveBeenCalledWith(
      'interactive-test', process.cwd(), "'agent' '--interactive'",
    );
    expect(tmux.sendPrompt).toHaveBeenCalledWith(
      process.cwd(), 'interactive-test', 'main', 'goal', 'goal_complete',
      expect.objectContaining({ agent: 'claude-code' }),
    );
  });

  it('does not submit the launch prompt twice for OpenCode', async () => {
    const tmux = {
      createSession: vi.fn(async () => ({})),
      sendPrompt: vi.fn(async () => {}),
      killSession: vi.fn(async () => {}),
      closeSession: vi.fn(),
    };
    const provider = new LocalSandboxProvider();
    const sandbox = await provider.create({
      worktreePath: process.cwd(),
      session: 'opencode-test',
      executionMode: 'interactive',
      tmux: tmux as never,
    });

    await sandbox.startAgent({
      command: { argv: ['opencode', '--auto'], cwd: process.cwd() },
      prompt: 'goal the runner must NOT type',
      generation: 1,
      signalType: 'goal_complete',
      executionMode: 'interactive',
      metadata: { provider: 'opencode', transport: 'process' },
    });

    expect(tmux.createSession).toHaveBeenCalled();
    expect(tmux.sendPrompt).not.toHaveBeenCalled();
  });

  it('still starts interactive flag-fed providers when the tmux client lacks the stability probe', async () => {
    const tmux = {
      createSession: vi.fn(async () => ({})),
      sendPrompt: vi.fn(async () => {}),
      killSession: vi.fn(async () => {}),
      closeSession: vi.fn(),
    };
    const provider = new LocalSandboxProvider();
    const sandbox = await provider.create({
      worktreePath: process.cwd(),
      session: 'opencode-legacy',
      executionMode: 'interactive',
      tmux: tmux as never,
    });

    await expect(sandbox.startAgent({
      command: { argv: ['opencode', '--auto'], cwd: process.cwd() },
      prompt: 'goal',
      generation: 1,
      signalType: 'goal_complete',
      executionMode: 'interactive',
      metadata: { provider: 'opencode', transport: 'process' },
    })).resolves.toBeDefined();
    expect(tmux.sendPrompt).not.toHaveBeenCalled();
  });

  it('clears a prior completion signal before starting the next interactive phase', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-sandbox-'));
    await writeFile(
      join(worktreePath, '.afk-signal.json'),
      JSON.stringify({
        type: 'goal_complete',
        timestamp: new Date().toISOString(),
        kind: 'task',
        summary: 'previous phase completed',
      }),
    );
    const tmux = {
      createSession: vi.fn(async () => ({})),
      sendPrompt: vi.fn(async () => {}),
      killSession: vi.fn(async () => {}),
      closeSession: vi.fn(),
    };
    const provider = new LocalSandboxProvider();
    const sandbox = await provider.create({
      worktreePath,
      session: 'interactive-test',
      executionMode: 'interactive',
      tmux: tmux as never,
    });

    await sandbox.startAgent({
      command: { argv: ['agent', '--interactive'], cwd: worktreePath },
      prompt: 'verify acceptance criteria',
      generation: 2,
      signalType: 'goal_complete',
      executionMode: 'interactive',
      metadata,
    });

    await expect(import('@afk/infrastructure').then(({ readSignal }) => readSignal(worktreePath))).resolves.toBeNull();
  });

  it('clears a stale status marker before launching an interactive session', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-status-'));
    const statusPath = join(worktreePath, '.afk', 'claude-status.json');
    await mkdir(join(worktreePath, '.afk'));
    await writeFile(statusPath, '{"stale":true}');
    const tmux = {
      createSession: vi.fn(async () => ({})),
      sendPrompt: vi.fn(async () => {}),
      killSession: vi.fn(async () => {}),
      closeSession: vi.fn(),
    };
    const provider = new LocalSandboxProvider();
    const sandbox = await provider.create({
      worktreePath, session: 'fresh-session', executionMode: 'interactive', tmux: tmux as never,
    });

    await sandbox.startAgent({
      command: { argv: ['agent'], cwd: worktreePath }, prompt: 'goal', generation: 1,
      signalType: 'goal_complete', executionMode: 'interactive',
      metadata,
    });

    await expect(access(statusPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a dead agent as a failure instead of waiting out the completion timeout', async () => {
    // The agent's session is the agent: when it ends, the agent is gone.
    // Waiting for the completion timeout to find that out would report a
    // crash as a timeout, hours later.
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-dead-'));
    const tmux = {
      createSession: vi.fn(async () => ({})),
      sendPrompt: vi.fn(async () => {}),
      sendKeys: vi.fn(async () => {}),
      killSession: vi.fn(async () => {}),
      closeSession: vi.fn(),
      hasSession: vi.fn(async () => false),
    };
    const execution = new LocalAgentExecution({
      worktreePath,
      sessionName: 'afk-dead',
      command: { argv: ['agent'], cwd: worktreePath },
      generation: 1,
      prompt: 'goal',
      signalType: 'goal_complete',
      metadata,
      tmux: tmux as never,
    });

    const result = await execution.waitForResult({ completionTimeoutMs: 2_000 });

    expect(result.status).toBe('failed');
  });

  it('accepts an AC verification completion signal', () => {
    expect(SignalSchema.safeParse({
      type: 'goal_complete',
      timestamp: new Date().toISOString(),
      kind: 'ac_verification',
      result: 'PASS',
      summary: 'acceptance criteria passed',
    }).success).toBe(true);
  });

  it('returns the parsed interactive signal as structured output', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-execution-'));
    const signal = {
      type: 'goal_complete' as const,
      timestamp: new Date().toISOString(),
      kind: 'task' as const,
      summary: 'acceptance criteria passed',
      failedCriteria: [],
    };
    await writeFile(join(worktreePath, '.afk-signal.json'), JSON.stringify(signal));
    const execution = new LocalAgentExecution({
      worktreePath,
      sessionName: 'interactive-test',
      command: { argv: ['agent'], cwd: worktreePath },
      generation: 1,
      prompt: 'verify acceptance criteria',
      signalType: 'goal_complete',
      metadata: { provider: 'claude-code', transport: 'process' },
      tmux: {} as never,
    });

    expect(execution.metadata).toEqual({ provider: 'claude-code', transport: 'process' });

    await expect(execution.waitForResult()).resolves.toMatchObject({
      status: 'completed',
      // The agent that ran, not the sandbox it ran in: the failure summary
      // a blocked work item carries names the agent.
      provider: 'claude-code',
      structuredOutput: signal,
    });
  });

  it('fails with the reason when the signal file cannot be read', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-execution-'));
    await writeFile(join(worktreePath, '.afk-signal.json'), '{not json');
    const execution = new LocalAgentExecution({
      worktreePath,
      sessionName: 'broken-signal',
      command: { argv: ['agent'], cwd: worktreePath },
      generation: 1,
      prompt: 'verify acceptance criteria',
      signalType: 'goal_complete',
      metadata: { provider: 'claude-code', transport: 'process' },
      tmux: {} as never,
    });

    // The agent finished and left a file nobody can read. Waiting cannot
    // mend it, and a timeout would name the wrong reason.
    await expect(execution.waitForResult({ completionTimeoutMs: 30_000 })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_SIGNAL_FILE' },
    });
  });
});
