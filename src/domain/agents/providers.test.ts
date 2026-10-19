import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeCodeProvider } from '@afk/execution/domain/agents/claude-code';
import { CodexProvider } from '@afk/execution/domain/agents/codex';
import { CursorProvider } from '@afk/execution/domain/agents/cursor';
import { PiProvider } from '@afk/execution/domain/agents/pi';
import { OpenCodeProvider, resolveOpenCodeModel } from '@afk/execution/domain/agents/opencode';
import { CopilotProvider } from '@afk/execution/domain/agents/copilot';
import {
  registerAgentProvider,
  requireAgentProvider,
  getAgentProvider,
  listAgentProviders,
  guardedRestoreSession,
  guardedCaptureSession,
  _resetAgentRegistry,
} from '@afk/execution/domain/agents/registry';
import { createAgentProvider, ensureBuiltinAgentProviders } from '@afk/execution/domain/agents/index';
import type { AgentExecution, Sandbox } from '@afk/execution/infrastructure/sandbox/types';
import type { AgentProvider } from '@afk/execution/domain/agents/types';

/** Build minimal AgentCommandOptions for testing. */
function opts(over: Partial<{ worktreePath: string; sessionId: string; goal: string; interactive: boolean }> = {}) {
  return {
    worktreePath: over.worktreePath ?? '/tmp/worktree',
    sessionId: over.sessionId ?? 'sess-1',
    goal: over.goal ?? 'do something',
    interactive: over.interactive,
  };
}

describe('Agent providers — fixture coverage', () => {
  beforeEach(() => {
    _resetAgentRegistry();
  });

  describe('ClaudeCodeProvider', () => {
    const p = new ClaudeCodeProvider();

    it('exposes correct name and capabilities', () => {
      expect(p.name).toBe('claude-code');
      expect(p.capabilities.has('streaming')).toBe(true);
      expect(p.capabilities.has('structured-output')).toBe(true);
      expect(p.capabilities.has('usage')).toBe(true);
      expect(p.capabilities.has('resume')).toBe(true);
      expect(p.capabilities.has('interactive')).toBe(true);
    });

    it('buildCommand produces the documented argv', () => {
      const cmd = p.buildCommand(opts({ interactive: true }));
      expect(cmd.argv[0]).toBe('claude');
      expect(cmd.argv).toContain('--dangerously-skip-permissions');
      expect(cmd.argv).not.toContain('--no-input');
      expect(cmd.cwd).toBe('/tmp/worktree');
    });

    it('builds stream-json output for batch execution', () => {
      const cmd = p.buildCommand({ ...opts(), executionMode: 'batch' });
      expect(cmd.argv).toContain('--print');
      expect(cmd.argv).toContain('--output-format');
      expect(cmd.argv).toContain('stream-json');
      expect(cmd.argv).not.toContain('--settings');
    });

    it('passes worktree-local settings explicitly for interactive readiness', () => {
      const command = new ClaudeCodeProvider().buildCommand({ ...opts(),
        worktreePath: '/tmp/worktree with spaces/qa', executionMode: 'interactive' });
      expect(command.argv).toEqual(['claude', '--dangerously-skip-permissions', '--settings',
        '/tmp/worktree with spaces/qa/.claude/settings.local.json']);
    });

    it('owns process execution creation and passes neutral parser metadata to the sandbox', async () => {
      const execution = { id: 'execution-1' } as AgentExecution;
      const startAgent = vi.fn(async () => execution);
      const sandbox = { startAgent } as unknown as Sandbox;

      await expect(p.createExecution({
        sandbox,
        worktreePath: '/tmp/worktree',
        sessionId: 'sess-1',
        prompt: 'do something',
        signalType: 'goal_complete',
        generation: 1,
        executionMode: 'batch',
      })).resolves.toBe(execution);

      expect(startAgent).toHaveBeenCalledWith(expect.objectContaining({
        command: expect.objectContaining({ argv: expect.arrayContaining(['claude']) }),
        metadata: { provider: 'claude-code', transport: 'process' },
        parseLine: expect.any(Function),
      }));
      expect(startAgent.mock.calls[0][0]).not.toHaveProperty('agentProvider');
    });

    it('surfaces an error result event from stream-json', () => {
      const provider = new ClaudeCodeProvider();
      expect(provider.parseLine(JSON.stringify({
        type: 'result', is_error: true, result: 'invalid request',
      }))).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'error', error: expect.objectContaining({ message: 'invalid request' }) }),
      ]));
    });

    it('parseLine routes JSON usage/result events', () => {
      const usage = p.parseLine(JSON.stringify({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }));
      expect(usage[0].type).toBe('usage');
      const result = p.parseLine(JSON.stringify({ type: 'result', result: { ok: true } }));
      expect(result[0].type).toBe('result');
    });

    it('parseLine falls back to text for non-JSON', () => {
      const text = p.parseLine('hello world');
      expect(text[0].type).toBe('text');
      expect((text[0] as { type: 'text'; text: string }).text).toBe('hello world');
    });
  });

  describe('CodexProvider', () => {
    const p = new CodexProvider();

    it('exposes correct name and capabilities (NO resume)', () => {
      expect(p.name).toBe('codex');
      expect(p.capabilities.has('resume')).toBe(false);
      expect(p.capabilities.has('usage')).toBe(true);
      expect(p.capabilities.has('interactive')).toBe(true);
    });

    it('builds JSONL batch execution with autonomous permissions', () => {
      const cmd = p.buildCommand({ ...opts(), executionMode: 'batch' });
      expect(cmd.argv).toEqual([
        'codex',
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        '/tmp/worktree',
      ]);
      expect(cmd.cwd).toBe('/tmp/worktree');
    });

    it('builds inline interactive execution with autonomous permissions', () => {
      const cmd = p.buildCommand({ ...opts(), executionMode: 'interactive' });
      expect(cmd.argv).toEqual([
        'codex',
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        '-C',
        '/tmp/worktree',
      ]);
    });

    it('applies the resolved Codex profile and explicit model provider', () => {
      const cmd = p.buildCommand({
        ...opts(),
        executionMode: 'batch',
        runtime: {
          kind: 'codex', transport: 'exec', auth: 'api', provider: 'custom',
          profile: 'work', startupTimeoutMs: 5_000,
        },
      });

      expect(cmd.argv).toEqual([
        'codex',
        'exec',
        '--json',
        '--profile',
        'work',
        '--config',
        'model_provider="custom"',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        '/tmp/worktree',
      ]);
    });

    it('does not override the provider selected by an exec profile', () => {
      const cmd = p.buildCommand({
        ...opts(),
        executionMode: 'batch',
        runtime: {
          kind: 'codex', transport: 'exec', auth: 'api', provider: 'auto',
          profile: 'work', startupTimeoutMs: 5_000,
        },
      });

      expect(cmd.argv).toContain('work');
      expect(cmd.argv).not.toContain('--config');
      expect(cmd.argv.some(arg => arg.startsWith('model_provider='))).toBe(false);
    });

    it('reports exec metadata with redacted runtime auth and model provider', async () => {
      const execution = { id: 'codex-execution' } as AgentExecution;
      const startAgent = vi.fn(async () => execution);

      await p.createExecution({
        sandbox: { startAgent } as unknown as Sandbox,
        worktreePath: '/tmp/worktree',
        sessionId: 'sess-1',
        prompt: 'do something',
        signalType: 'goal_complete',
        generation: 1,
        executionMode: 'batch',
        runtime: {
          kind: 'codex',
          transport: 'exec',
          auth: 'chatgpt',
          provider: 'openai',
          startupTimeoutMs: 5_000,
        },
      });

      expect(startAgent).toHaveBeenCalledWith(expect.objectContaining({
        metadata: {
          provider: 'codex',
          transport: 'exec',
          auth: 'chatgpt',
          modelProvider: 'openai',
        },
      }));
    });

    it('selects app-server execution before delegating to a process sandbox', async () => {
      const startAgent = vi.fn();
      await expect(p.createExecution({
        sandbox: {
          id: 'container', worktreePath: '/host/worktree', workspacePath: '/workspace', startAgent,
        } as unknown as Sandbox,
        worktreePath: '/host/worktree',
        sessionId: 'sess-app-server',
        prompt: 'do something',
        signalType: 'goal_complete',
        generation: 1,
        executionMode: 'batch',
        runtime: {
          kind: 'codex', transport: 'app-server', auth: 'chatgpt', provider: 'openai',
          endpoint: 'stdio://', startupTimeoutMs: 5_000,
        },
      })).rejects.toThrow(/container/i);
      expect(startAgent).not.toHaveBeenCalled();
    });

    it('parses completed agent messages as result events', () => {
      const events = p.parseLine(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>',
        },
      }));

      expect(events).toEqual([{ type: 'result', result: expect.stringContaining('goal_complete') }]);
    });

    it('normalizes turn usage and surfaces Codex errors', () => {
      expect(p.parseLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 4 },
      }))).toContainEqual({
        type: 'usage',
        usage: { inputTokens: 13, outputTokens: 4, totalTokens: 17 },
      });

      const [event] = p.parseLine(JSON.stringify({ type: 'error', message: 'request failed' }));
      expect(event).toMatchObject({
        type: 'error',
        error: expect.objectContaining({ message: 'request failed' }),
      });
    });

    it('parseLine returns text for unknown or malformed input', () => {
      const events = p.parseLine('hello');
      expect(events[0].type).toBe('text');
      expect(p.parseLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }))).toEqual([
        { type: 'session', sessionId: 'thread-1' },
      ]);
    });
  });

  describe('CursorProvider', () => {
    const p = new CursorProvider();

    it('exposes correct name and capabilities (HAS resume)', () => {
      expect(p.name).toBe('cursor');
      expect(p.capabilities.has('resume')).toBe(true);
      expect(p.capabilities.has('streaming')).toBe(true);
      expect(p.capabilities.has('usage')).toBe(true);
    });

    it('buildCommand uses --print when non-interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: false }));
      expect(cmd.argv[0]).toBe('cursor-agent');
      expect(cmd.argv).toContain('--print');
    });

    it('buildCommand uses --interactive when interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: true }));
      expect(cmd.argv).toContain('--interactive');
    });

    it('parseLine routes JSON events', () => {
      const events = p.parseLine(JSON.stringify({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }));
      expect(events[0].type).toBe('usage');
    });
  });

  describe('PiProvider', () => {
    const p = new PiProvider();

    it('exposes correct name and capabilities (HAS resume)', () => {
      expect(p.name).toBe('pi');
      expect(p.capabilities.has('resume')).toBe(true);
      expect(p.capabilities.has('streaming')).toBe(true);
    });

    it('buildCommand uses --non-interactive when not interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: false }));
      expect(cmd.argv[0]).toBe('pi');
      expect(cmd.argv).toContain('--non-interactive');
    });

    it('buildCommand omits --non-interactive when interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: true }));
      expect(cmd.argv).not.toContain('--non-interactive');
    });
  });

  describe('OpenCodeProvider', () => {
    const p = new OpenCodeProvider();

    it('exposes correct name and capabilities (NO resume)', () => {
      expect(p.name).toBe('opencode');
      expect(p.capabilities.has('resume')).toBe(false);
      expect(p.capabilities.has('streaming')).toBe(true);
      expect(p.capabilities.has('usage')).toBe(true);
      expect(p.capabilities.has('interactive')).toBe(true);
    });

    it('builds the TUI command with auto-approve for interactive execution', () => {
      const cmd = p.buildCommand({ ...opts({ interactive: true }), executionMode: 'interactive' });
      expect(cmd.argv[0]).toBe('opencode');
      expect(cmd.argv[1]).not.toBe('run');
      expect(cmd.argv).not.toContain('--format');
      expect(cmd.argv).not.toContain('--non-interactive');
      expect(cmd.argv).toContain('--auto');
      expect(cmd.cwd).toBe('/tmp/worktree');
    });

    it('passes the goal via --prompt for TUI auto-submit', () => {
      const cmd = p.buildCommand({ ...opts({ goal: 'implement feature X' }), executionMode: 'interactive' });
      const promptIndex = cmd.argv.indexOf('--prompt');
      expect(promptIndex).toBeGreaterThan(-1);
      expect(cmd.argv[promptIndex + 1]).toBe('implement feature X');
    });

    it('passes the runner prompt intact when creating an interactive execution', async () => {
      const startAgent = vi.fn(async () => ({ id: 'interactive-opencode' } as AgentExecution));
      const prompt = '/goal Implement the assigned task.\nBacklog description: exact acceptance criteria.\nAFK interactive completion protocol: write .afk-signal.json.';
      await p.createExecution({
        worktreePath: '/tmp/worktree',
        sessionId: 'sess-1',
        sandbox: { startAgent } as unknown as Sandbox,
        generation: 1,
        prompt,
        signalType: 'goal_complete',
        executionMode: 'interactive',
      });
      expect(startAgent).toHaveBeenCalledWith(expect.objectContaining({
        command: expect.objectContaining({ argv: expect.arrayContaining(['--prompt', prompt.replace(/^\/goal\s*/, '')]) }),
        prompt,
      }));
    });

    it('builds run --format json for batch execution', () => {
      const cmd = p.buildCommand({ ...opts(), executionMode: 'batch' });
      expect(cmd.argv).toEqual(['opencode', 'run', '--format', 'json']);
      expect(cmd.cwd).toBe('/tmp/worktree');
    });

    it('resolves --model from the environment and never hardcodes one', () => {
      const interactive = p.buildCommand({ ...opts({ interactive: true }), executionMode: 'interactive' });
      expect(interactive.argv).not.toContain('--model');

      const batch = p.buildCommand({ ...opts(), executionMode: 'batch' });
      expect(batch.argv).not.toContain('--model');

      const modelEnv = process.env.AFK_OPENCODE_MODEL;
      process.env.AFK_OPENCODE_MODEL = 'acme/model-x';
      try {
        const configured = p.buildCommand({ ...opts({ interactive: true }), executionMode: 'interactive' });
        const modelIndex = configured.argv.indexOf('--model');
        expect(modelIndex).toBeGreaterThan(-1);
        expect(configured.argv[modelIndex + 1]).toBe('acme/model-x');
      } finally {
        if (modelEnv === undefined) delete process.env.AFK_OPENCODE_MODEL;
        else process.env.AFK_OPENCODE_MODEL = modelEnv;
      }

      expect(resolveOpenCodeModel({ AFK_OPENCODE_MODEL: 'acme/model-x' })).toBe('acme/model-x');
      expect(resolveOpenCodeModel({})).toBeUndefined();
      expect(resolveOpenCodeModel({ AFK_OPENCODE_MODEL: '   ' })).toBeUndefined();
    });

    it('routes step_finish tokens into usage and result events', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        timestamp: 1791992467521,
        sessionID: 'ses_x',
        part: { type: 'step-finish', reason: 'stop', tokens: { total: 703, input: 700, output: 3 } },
      });
      const events = p.parseLine(line);
      const usage = events.find(e => e.type === 'usage');
      expect(usage).toMatchObject({ usage: { inputTokens: 700, outputTokens: 3, totalTokens: 703 } });
      expect(events.some(e => e.type === 'result')).toBe(true);
    });

    it('captures the session id from step_start', () => {
      const line = JSON.stringify({ type: 'step_start', sessionID: 'ses_ec4e', part: { type: 'step-start' } });
      const events = p.parseLine(line);
      expect(events[0]).toEqual({ type: 'session', sessionId: 'ses_ec4e' });
    });

    it('exposes completion text to the batch signal reader', () => {
      const text = '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>';
      expect(p.parseLine(JSON.stringify({ type: 'text', part: { text } })))
        .toContainEqual({ type: 'result', result: text });
    });

    it('falls back to text for non-JSON lines', () => {
      expect(p.parseLine('plain output')[0].type).toBe('text');
    });
  });

  describe('CopilotProvider', () => {
    const p = new CopilotProvider();

    it('exposes correct name and capabilities (NO resume)', () => {
      expect(p.name).toBe('copilot');
      expect(p.capabilities.has('resume')).toBe(false);
      expect(p.capabilities.has('streaming')).toBe(true);
      expect(p.capabilities.has('usage')).toBe(true);
    });

    it('buildCommand uses --allow-all when non-interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: false }));
      expect(cmd.argv[0]).toBe('copilot');
      expect(cmd.argv).toContain('--allow-all');
    });
  });
});

describe('Agent registry', () => {
  beforeEach(() => {
    _resetAgentRegistry();
  });

  it('register + lookup', () => {
    const fake: AgentProvider = {
      name: 'claude-code',
      capabilities: new Set(['usage']),
      createExecution: async () => ({ id: 'fake' }) as AgentExecution,
    };
    registerAgentProvider(fake);
    expect(requireAgentProvider('claude-code')).toBe(fake);
    expect(getAgentProvider('codex')).toBeUndefined();
  });

  it('requireAgentProvider throws for missing', () => {
    expect(() => requireAgentProvider('codex')).toThrow(/not registered/);
  });

  it('listAgentProviders returns registered names', () => {
    registerAgentProvider(new ClaudeCodeProvider());
    registerAgentProvider(new CodexProvider());
    expect(listAgentProviders()).toEqual(['claude-code', 'codex']);
  });

  it('bootstraps builtin providers after a registry reset', () => {
    _resetAgentRegistry();
    ensureBuiltinAgentProviders();
    expect(listAgentProviders().sort()).toEqual(['claude-code', 'codex', 'copilot', 'cursor', 'opencode', 'pi']);
    _resetAgentRegistry();
    expect(createAgentProvider('codex').name).toBe('codex');
  });
});

describe('Resume capability gating', () => {
  const resumeProvider = new ClaudeCodeProvider(); // HAS resume
  const noResumeProvider = new CodexProvider();   // NO resume

  it('guardedRestoreSession throws for non-resume provider', async () => {
    await expect(guardedRestoreSession(noResumeProvider, {
      snapshot: {
        sessionId: 'x',
        generation: 1,
        checkpoint: null,
        summary: '',
        capturedAt: new Date().toISOString(),
      },
      worktreePath: '/tmp',
    })).rejects.toThrow(/does not support resume/);
  });

  it('guardedRestoreSession succeeds for resume-capable provider', async () => {
    // ClaudeCodeProvider.restoreSession is a no-op; should not throw.
    await expect(guardedRestoreSession(resumeProvider, {
      snapshot: {
        sessionId: 'x',
        generation: 1,
        checkpoint: null,
        summary: '',
        capturedAt: new Date().toISOString(),
      },
      worktreePath: '/tmp',
    })).resolves.toBeUndefined();
  });

  it('guardedCaptureSession throws for non-resume provider', async () => {
    await expect(guardedCaptureSession(noResumeProvider, {
      sessionId: 'x',
      worktreePath: '/tmp',
    })).rejects.toThrow(/does not support resume/);
  });
});
