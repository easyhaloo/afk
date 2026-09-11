import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeProvider } from './claude-code';
import { CodexProvider } from './codex';
import { CursorProvider } from './cursor';
import { PiProvider } from './pi';
import { OpenCodeProvider } from './opencode';
import { CopilotProvider } from './copilot';
import {
  registerAgentProvider,
  requireAgentProvider,
  getAgentProvider,
  listAgentProviders,
  guardedRestoreSession,
  guardedCaptureSession,
  _resetAgentRegistry,
} from './registry';
import { createAgentProvider, ensureBuiltinAgentProviders } from './index';
import type { AgentProvider } from './types';

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
      expect(cmd.cwd).toBe('/tmp/worktree');
    });

    it('builds stream-json output for batch execution', () => {
      const cmd = p.buildCommand({ ...opts(), executionMode: 'batch' });
      expect(cmd.argv).toContain('--print');
      expect(cmd.argv).toContain('--output-format');
      expect(cmd.argv).toContain('stream-json');
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

    it('buildCommand produces argv starting with "codex"', () => {
      const cmd = p.buildCommand(opts({ interactive: true }));
      expect(cmd.argv[0]).toBe('codex');
      expect(cmd.argv).toContain('--full-auto');
    });

    it('parseLine returns text for unknown input', () => {
      const events = p.parseLine('hello');
      expect(events[0].type).toBe('text');
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
    });

    it('buildCommand always uses --format json', () => {
      const cmd = p.buildCommand(opts({}));
      expect(cmd.argv[0]).toBe('opencode');
      expect(cmd.argv).toContain('--format');
      expect(cmd.argv).toContain('json');
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
      buildCommand: () => ({ argv: ['fake'] }),
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
