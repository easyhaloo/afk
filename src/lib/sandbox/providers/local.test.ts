import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { SignalSchema } from '../../schemas';
import { LocalAgentExecution, LocalSandboxProvider } from './local';

describe('LocalSandboxProvider', () => {
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
    });

    expect(tmux.createSession).toHaveBeenCalledWith(
      'interactive-test', process.cwd(), "'agent' '--interactive'",
    );
    expect(tmux.sendPrompt).toHaveBeenCalledWith(
      process.cwd(), 'interactive-test', 'main', 'goal', 'goal_complete',
    );
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
    });

    await expect(import('../../io').then(({ readSignal }) => readSignal(worktreePath))).resolves.toBeNull();
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
      tmux: {} as never,
    });

    await expect(execution.waitForResult()).resolves.toMatchObject({
      status: 'completed',
      structuredOutput: signal,
    });
  });
});
