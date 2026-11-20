import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeCodeProvider } from './claude-code.js';
import { claudeStatuslineSettingsPath } from '../../shared/workspace-paths.js';
import { CodexProvider } from './codex.js';
import { CodexAppServerExecution } from './codex-app-server/execution.js';
import { CursorProvider } from './cursor.js';
import { PiProvider } from './pi.js';
import { OpenCodeProvider, resolveOpenCodeModel } from './opencode.js';
import { CopilotProvider } from './copilot.js';
import {
  registerAgentProvider,
  requireAgentProvider,
  getAgentProvider,
  listAgentProviders,
  guardedRestoreSession,
  guardedCaptureSession,
  _resetAgentRegistry,
} from './registry.js';
import { AgentProviderRegistry, createAgentProvider, ensureBuiltinAgentProviders } from './index.js';
import type { AgentExecution, Sandbox } from '../../infrastructure/sandbox/types.js';
import type { AgentProvider, AgentStartOptions } from './types.js';

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

  it('resolves an extension provider from an injected registry', () => {
    const provider = { name: 'review-agent', capabilities: new Set(), createExecution: vi.fn() } as unknown as AgentProvider;
    const registry = new AgentProviderRegistry([provider]);

    expect(registry.require('review-agent')).toBe(provider);
    expect(createAgentProvider('review-agent', registry)).toBe(provider);
  });

  describe('ClaudeCodeProvider', () => {
    const p = new ClaudeCodeProvider();

    it('exposes correct name and capabilities (NO resume)', () => {
      expect(p.name).toBe('claude-code');
      expect(p.capabilities.has('streaming')).toBe(true);
      expect(p.capabilities.has('structured-output')).toBe(true);
      expect(p.capabilities.has('usage')).toBe(true);
      expect(p.capabilities.has('resume')).toBe(false);
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

    it('passes workspace state settings explicitly for interactive readiness', () => {
      const command = new ClaudeCodeProvider().buildCommand({ ...opts(),
        worktreePath: '/tmp/worktree with spaces/qa', executionMode: 'interactive' });
      expect(command.argv).toEqual(['claude', '--dangerously-skip-permissions', '--settings',
        claudeStatuslineSettingsPath('/tmp/worktree with spaces/qa')]);
    });

    it('owns process execution creation and passes neutral parser metadata to the sandbox', async () => {
      const execution = { id: 'execution-1' } as AgentExecution;
      const startAgent = vi.fn(async (_options: AgentStartOptions) => execution);
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

    it('exposes transport-scoped resume', () => {
      expect(p.name).toBe('codex');
      expect(p.capabilities.has('resume')).toBe(true);
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
        '--config',
        'check_for_update_on_startup=false',
        '-C',
        '/tmp/worktree',
      ]);
    });

    it('disables the startup update check so no modal can swallow the goal', () => {
      const interactive = p.buildCommand({ ...opts(), executionMode: 'interactive' });
      expect(interactive.argv.some(arg => arg.includes('check_for_update_on_startup=false'))).toBe(true);

      const batch = p.buildCommand({ ...opts(), executionMode: 'batch' });
      expect(batch.argv.some(arg => arg.includes('check_for_update_on_startup'))).toBe(false);
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

    it.each([
      ['exec', false], ['app-server', false], ['exec', true], ['app-server', true],
    ] as const)('rejects explicit resume before starting %s (remote=%s)', async (transport, remote) => {
      const startAgent = vi.fn();
      const startProviderExecution = vi.fn();
      const appServer = vi.spyOn(CodexAppServerExecution, 'start').mockRejectedValue(new Error('unexpected start'));
      try {
        await expect(p.createExecution({
          sandbox: { startAgent, ...(remote && { startProviderExecution }) } as unknown as Sandbox,
          worktreePath: '/tmp/worktree', sessionId: 'sess-1', generation: 2,
          prompt: 'continue', signalType: 'goal_complete', executionMode: 'batch',
          runtime: { kind: 'codex', transport, auth: 'chatgpt', provider: 'openai', startupTimeoutMs: 5_000 },
          resume: { sessionId: 'thread-1', generation: 1, checkpoint: null, summary: '', capturedAt: new Date().toISOString() },
        })).rejects.toThrow('codex does not support explicit native resume');
        expect(appServer).not.toHaveBeenCalled();
        expect(startAgent).not.toHaveBeenCalled();
        expect(startProviderExecution).not.toHaveBeenCalled();
      } finally { appServer.mockRestore(); }
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
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
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

    it('buildCommand uses the default TUI when interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: true }));
      expect(cmd.argv).toEqual(['cursor-agent']);
    });

    it('parseLine routes JSON events', () => {
      const events = p.parseLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { inputTokens: 0, outputTokens: 0 } }));
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

    it('buildCommand uses print JSON mode when not interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: false }));
      expect(cmd.argv).toEqual(['pi', '--print', '--mode', 'json']);
    });

    it('buildCommand uses the default TUI when interactive', () => {
      const cmd = p.buildCommand(opts({ interactive: true }));
      expect(cmd.argv).toEqual(['pi']);
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
      const execution = await p.createExecution({
        worktreePath: '/tmp/worktree',
        sessionId: 'sess-1',
        sandbox: { startAgent } as unknown as Sandbox,
        generation: 1,
        prompt,
        signalType: 'goal_complete',
        executionMode: 'interactive',
      });
      expect(execution).toBe(await startAgent.mock.results[0].value);
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

    it('isolates scoped batch runs and keeps the task out of other launches', () => {
      const skillTask = { workspace: '/tmp/worktree', taskId: 'github:w11/parcel#42', runId: 'parcel-run',
        target: { project: 'github:w11/parcel', productVersions: { parcel: '2.0' } }, applicability: { environment: 'staging' } };
      const options = { ...opts(), skillTask };
      const batch = p.buildCommand({ ...options, executionMode: 'batch' });
      expect(batch.argv).toContain('--standalone');
      expect(batch.env?.AFK_SKILL_TASK_CONTEXT).toBe(JSON.stringify(skillTask));
      for (const other of [p.buildCommand({ ...options, worktreePath: '/tmp/other', executionMode: 'batch' }),
        p.buildCommand({ ...options, executionMode: 'interactive' })]) {
        expect(other.argv).not.toContain('--standalone');
        expect(other.env?.AFK_SKILL_TASK_CONTEXT).toBeUndefined();
      }
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

    const row = (type: string, fields = {}, messageID = 'msg_one') => JSON.stringify({ type, sessionID: 'ses_one',
      part: { type: type.replace('_', '-'), sessionID: 'ses_one', messageID, ...fields } });

    async function batch() {
      const startAgent = vi.fn(async (_options: AgentStartOptions) => ({ id: 'logical' }) as AgentExecution);
      const execution = await p.createExecution({ ...opts(), sandbox: { startAgent } as unknown as Sandbox,
        executionMode: 'batch', generation: 0, prompt: 'compute', signalType: 'goal_complete' });
      return { execution, parse: startAgent.mock.calls[0][0].parseLine! };
    }

    it('binds the native session and publishes its stopped answer after usage', async () => {
      const { execution, parse } = await batch();
      expect(execution.sessionId).toBeUndefined();
      expect(parse(row('step_start'))).toEqual([{ type: 'session', sessionId: 'ses_one' }]);
      expect(execution.sessionId).toBe('ses_one');
      expect(parse(row('text', { text: '41' }))).toEqual([{ type: 'text', text: '41' }]);
      expect(parse(row('step_finish', { reason: 'stop', tokens: { input: 636, output: 119 } }))).toEqual([
        { type: 'usage', usage: { inputTokens: 636, outputTokens: 119, totalTokens: 755 } }, { type: 'result', result: '41' }]);
      await expect(p.restoreSession()).rejects.toThrow(/resume/);
    });

    it('isolates executions and excludes unrelated, intermediate and failed steps', async () => {
      const { parse } = await batch();
      const other = await batch();
      parse(row('step_start'));
      parse(row('text', { text: 'intermediate' }));
      expect(other.parse(row('step_finish', { reason: 'stop' }))).toEqual([]);
      expect(parse(row('step_finish', { reason: 'stop' }, 'wrong'))).toEqual([]);
      expect(parse(row('step_finish', { reason: 'tool-calls', tokens: { input: 1 } }))).toEqual([]);
      parse(row('step_start'));
      expect(parse(row('text', { text: 'mixed', sessionID: 'ses_other' }))).toEqual([]);
      expect(parse(row('step_finish', { reason: 'length' }))).toEqual([]);
      parse(row('step_start'));
      parse(row('text', { text: 'discard' }));
      expect(parse(JSON.stringify({ type: 'error' }))[0].type).toBe('error');
      expect(parse(row('step_finish', { reason: 'stop' }))).toEqual([]);
      expect(parse('plain output')).toEqual([{ type: 'text', text: 'plain output' }]);
    });

    it('counts completed tool and answer messages once, including cached and reasoning tokens', async () => {
      const { parse } = await batch();
      const text = '{"type":"goal_complete","summary":"intermediate"}';
      parse(row('step_start'));
      parse(row('text', { text }));
      expect(parse(row('tool_use', { type: 'tool', state: { output: text } }))).toEqual([]);
      const finish = row('step_finish', { reason: 'tool-calls', tokens: { input: 811, output: 92 } });
      expect(parse(finish)).toEqual([{ type: 'usage', usage: { inputTokens: 811, outputTokens: 92, totalTokens: 903 } }]);
      expect(parse(finish)).toEqual([]);
      parse(row('step_start', {}, 'final'));
      parse(row('text', { text: '{"type":"goal_complete",' }, 'final'));
      parse(row('text', { text: '"summary":"41"}' }, 'final'));
      expect(parse(row('step_finish', { reason: 'stop', tokens: { input: 36, output: 77, reasoning: 3, cache: { read: 900, write: 3 } } }, 'final')))
        .toEqual([{ type: 'usage', usage: { inputTokens: 1750, outputTokens: 172, totalTokens: 1922 } },
          { type: 'result', result: '{"type":"goal_complete","summary":"41"}' }]);
      expect(parse(row('step_start', {}, 'extra'))[0]?.type).toBe('error');
    });

    it('does not publish text from a tool-bearing stop', async () => {
      const { parse } = await batch();
      parse(row('step_start'));
      parse(row('text', { text: 'intermediate' }));
      parse(row('tool_use', { type: 'tool' }));
      expect(parse(row('step_finish', { reason: 'stop' }))).toEqual([]);
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

    it('uses stdin JSONL in batch and leaves the interactive command alone', () => {
      expect(p.buildCommand(opts()).argv).toEqual(['copilot', '--output-format', 'json', '--stream', 'on']);
      expect(p.buildCommand(opts({ interactive: true })).argv).toEqual(['copilot']);
    });

    it('accepts assistant content only on a matching successful terminal event', () => {
      class Probe extends CopilotProvider { parser() { return this.createParser(); } }
      const parse = new Probe().parser();
      const row = (type: string, data: unknown) => parse(JSON.stringify({ type, data }));
      const terminal = (exitCode: number, sessionId = 'native') => parse(JSON.stringify({ type: 'result', exitCode, sessionId }));
      expect(row('session.start', { sessionId: 'native', context: { cwd: '/tmp/work' } })).toEqual([
        { type: 'session', sessionId: 'native', worktreePath: '/tmp/work' },
      ]);
      expect(row('user.message', { content: 'goal_complete' })).toEqual([]);
      expect(row('assistant.message_delta', { deltaContent: 'part' })).toEqual([{ type: 'text', text: 'part' }]);
      expect(terminal(0)[0]?.type).toBe('error');
      expect(row('assistant.message', { content: 'final', toolRequests: [] })).toEqual([]);
      expect(terminal(1)[0]?.type).toBe('error');
      expect(terminal(0, 'other')[0]?.type).toBe('error');
      expect(terminal(0)).toEqual([{ type: 'result', result: 'final' }]);
      row('assistant.turn_start', {});
      row('assistant.message', { content: 'unfinished', toolRequests: [{ name: 'read' }] });
      expect(terminal(0)[0]?.type).toBe('error');
      expect(row('session.error', { message: 'offline' })[0]?.type).toBe('error');
      expect(parse('not json')).toEqual([]);
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
  const resumeProvider = new CursorProvider(); // HAS resume
  const noResumeProvider = new OpenCodeProvider();

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

  it('guardedRestoreSession rejects a synthetic snapshot for a resume-capable provider', async () => {
    await expect(guardedRestoreSession(resumeProvider, {
      snapshot: {
        sessionId: 'x',
        generation: 1,
        checkpoint: null,
        summary: '',
        capturedAt: new Date().toISOString(),
      },
      worktreePath: '/tmp',
    })).rejects.toThrow(/native session snapshot/);
  });

  it('guardedCaptureSession throws for non-resume provider', async () => {
    await expect(guardedCaptureSession(noResumeProvider, {
      sessionId: 'x',
      worktreePath: '/tmp',
    })).rejects.toThrow(/does not support resume/);
  });
});
