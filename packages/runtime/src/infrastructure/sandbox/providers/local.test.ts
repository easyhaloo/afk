import { workspaceDataDirectory } from '../../workspace.js';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { SignalSchema } from '../../../domain/schemas.js';
import { LocalAgentExecution, LocalSandboxProvider } from './local.js';

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
      metadata,
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
      process.cwd(), 'interactive-test', 'main', 'goal', 'goal_complete', 'claude-code',
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

  it('persists the Claude Code workspace trust before the agent process starts', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'afk-claude-config-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-sandbox-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      let trustedAtLaunch = false;
      const tmux = {
        createSession: vi.fn(async () => {
          const config = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8')) as {
            projects?: { [key: string]: { hasTrustDialogAccepted?: boolean } };
          };
          trustedAtLaunch = config.projects?.[worktreePath]?.hasTrustDialogAccepted === true;
          return {};
        }),
        sendPrompt: vi.fn(async () => {}),
        killSession: vi.fn(async () => {}),
        closeSession: vi.fn(),
      };
      const provider = new LocalSandboxProvider();
      const sandbox = await provider.create({
        worktreePath,
        session: 'claude-trust-test',
        executionMode: 'interactive',
        metadata,
        tmux: tmux as never,
      });

      await sandbox.startAgent({
        command: { argv: ['claude', '--dangerously-skip-permissions'], cwd: worktreePath },
        prompt: 'goal',
        generation: 1,
        signalType: 'goal_complete',
        executionMode: 'interactive',
        metadata,
      });

      expect(trustedAtLaunch).toBe(true);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  it('does not touch the Claude Code config for other agents', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'afk-claude-config-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-sandbox-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const tmux = {
        createSession: vi.fn(async () => ({})),
        sendPrompt: vi.fn(async () => {}),
        killSession: vi.fn(async () => {}),
        closeSession: vi.fn(),
      };
      const provider = new LocalSandboxProvider();
      const sandbox = await provider.create({
        worktreePath,
        session: 'codex-trust-test',
        executionMode: 'interactive',
        metadata: { provider: 'codex', transport: 'process' },
        tmux: tmux as never,
      });

      await sandbox.startAgent({
        command: { argv: ['codex', 'exec'], cwd: worktreePath },
        prompt: 'goal',
        generation: 1,
        signalType: 'goal_complete',
        executionMode: 'interactive',
        metadata: { provider: 'codex', transport: 'process' },
      });

      await expect(readFile(join(configDir, '.claude.json'), 'utf8')).rejects.toThrow();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
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

    await expect(import('../../io/index.js').then(({ readSignal }) => readSignal(worktreePath))).resolves.toBeNull();
  });

  it('clears a stale status marker before launching an interactive session', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'afk-local-status-'));
    const statusPath = join(workspaceDataDirectory(worktreePath), 'claude-status.json');
    await mkdir(workspaceDataDirectory(worktreePath), { recursive: true });
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
      structuredOutput: signal,
    });
  });
});
