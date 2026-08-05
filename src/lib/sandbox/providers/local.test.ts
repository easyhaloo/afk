import { describe, expect, it, vi } from 'vitest';
import { LocalSandboxProvider } from './local';

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
});
