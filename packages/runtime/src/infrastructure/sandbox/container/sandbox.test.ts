import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorProvider } from '../../../domain/agents/cursor.js';
import { PiProvider } from '../../../domain/agents/pi.js';
import { CodexProvider } from '../../../domain/agents/codex.js';
import type { AgentStartOptions } from '../../../domain/agents/types.js';
import { collectAgentTelemetry } from '../../observability/agent-telemetry.js';
import { ContainerAgentExecution, ContainerSandbox } from './sandbox.js';
import type { ContainerCreateOptions, ContainerEngine, ContainerProvider } from './types.js';

const goal = { type: 'goal_complete', summary: 'finished', timestamp: '2026-11-13T00:00:00Z' };
const marker = `<goal_complete>${JSON.stringify(goal)}</goal_complete>`;
const usage = { inputTokens: 15, outputTokens: 4, totalTokens: 19 };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function files(engine: ContainerEngine = 'docker') {
  const root = await fs.mkdtemp(join(tmpdir(), 'afk-container-native-'));
  roots.push(root);
  const paths = { outputPath: join(root, 'stdout'), errorPath: join(root, 'stderr'), exitPath: join(root, 'exit') };
  const unexpected = async (): Promise<never> => { throw new Error('unexpected container operation'); };
  const provider: ContainerProvider = {
    engine, binary: engine, isAvailable: unexpected, create: unexpected, exec: unexpected,
    killExec: unexpected, killContainer: vi.fn(async () => {}), remove: unexpected, inspect: unexpected,
  };
  return {
    root, paths, provider,
    async write(lines: unknown[], exit = 0) {
      await fs.writeFile(paths.outputPath, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\r\n'));
      await fs.writeFile(paths.errorPath, '');
      await fs.writeFile(paths.exitPath, String(exit));
    },
    start(options: Partial<AgentStartOptions> = {}) {
      return new ContainerAgentExecution({
        ...paths, provider, containerId: 'container', execId: 'exec', worktreePath: root,
        sessionName: 'logical-container-session', generation: 1, signalType: 'goal_complete',
        metadata: options.metadata ?? { provider: 'test', transport: 'process' }, parseLine: options.parseLine,
      });
    },
  };
}

function nativeLines(name: 'cursor' | 'pi', root: string) {
  return name === 'cursor' ? [
    { type: 'system', subtype: 'init', session_id: 'native-cursor', cwd: root },
    { type: 'result', subtype: 'success', session_id: 'native-cursor', result: marker,
      usage: { inputTokens: 5, outputTokens: 1 } },
    { type: 'result', subtype: 'success', session_id: 'native-cursor', result: marker,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 } },
  ] : [
    { type: 'session', id: 'native-pi', cwd: root },
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: marker }],
      usage: { input: 5, output: 1 } } },
    { type: 'agent_settled' },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: marker }],
      usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 } } },
    { type: 'agent_settled' },
  ];
}

function nativeError(name: 'cursor' | 'pi') {
  return name === 'cursor'
    ? [{ type: 'result', is_error: true, result: 'native rejected' }]
    : [{ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'native rejected' } },
      { type: 'agent_settled' }];
}

async function containerHost(engine: ContainerEngine, name: 'cursor' | 'pi' | 'codex', layout: 'single' | 'nested' | 'custom',
  reportedCwd?: (cwd: string, host: string) => string) {
  const f = await files(engine);
  const worktreePath = layout === 'single' ? f.root : join(f.root, 'repositories', 'api');
  await fs.mkdir(worktreePath, { recursive: true });
  const workdir = layout === 'custom' ? '/workspace/repositories/api/tool cwd' : undefined;
  const expectedCwd = workdir ?? (layout === 'single' ? '/workspace' : '/workspace/repositories/api');
  let created!: ContainerCreateOptions;
  f.provider.create = vi.fn(async options => { created = options; return { id: 'container', name: 'container', engine }; });
  f.provider.remove = vi.fn(async () => {});
  f.provider.exec = vi.fn(async options => {
    const cwd = reportedCwd?.(options.workdir!, worktreePath) ?? options.workdir!;
    const lines = name === 'codex' ? [
      { type: 'thread.started', thread_id: 'native-codex' },
      { type: 'item.completed', item: { type: 'agent_message', text: marker } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 2, output_tokens: 4 } },
    ] : nativeLines(name, cwd);
    const resultMount = created.mounts.find(mount => mount.containerPath === '/afk/result')!;
    for (const suffix of ['stdout', 'stderr', 'exit']) {
      const destination = options.command[2].match(new RegExp(`/afk/result/([^']+\\.${suffix})'`))![1];
      await fs.writeFile(join(resultMount.hostPath, destination), suffix === 'stdout'
        ? lines.map(line => JSON.stringify(line)).join('\n') : suffix === 'exit' ? '0' : '');
    }
    return { execId: 'exec' };
  });
  const sandbox = new ContainerSandbox({ worktreePath, workspaceRoot: f.root, workdir, image: 'offline', user: '1000:1000' });
  sandbox.bindProvider(f.provider);
  await sandbox.createContainer();
  const start = vi.spyOn(sandbox, 'startAgent');
  const provider = name === 'cursor' ? new CursorProvider() : name === 'pi' ? new PiProvider() : new CodexProvider();
  const options = { sandbox, worktreePath, sessionId: 'logical', prompt: 'finish', generation: 1,
    signalType: 'goal_complete' as const, executionMode: 'batch' as const };
  return { ...f, sandbox, start, provider, options, expectedCwd };
}

describe.each(['docker', 'podman'] as const)('actual container path contract / %s', engine => {
  describe.each(['cursor', 'pi', 'codex'] as const)('%s', name => {
    it.each(['single', 'nested', 'custom'] as const)('uses the %s execution cwd for commands, native identity and resume', async layout => {
      const f = await containerHost(engine, name, layout);
      try {
        const execution = await f.provider.createExecution(f.options);
        expect(f.sandbox.workspacePath).toBe(f.expectedCwd);
        expect(f.start.mock.calls[0][0].command.cwd).toBe(f.expectedCwd);
        const argv = f.start.mock.calls[0][0].command.argv;
        if (name === 'codex') expect(argv[argv.indexOf('-C') + 1]).toBe(f.expectedCwd);
        const result = await execution.waitForResult();
        expect(result).toMatchObject({ status: 'completed', usage, structuredOutput: goal });
        expect(execution.metadata.threadId).toBe(`native-${name}`);
        if (name !== 'codex') {
          const captured = (await execution.captureSession())!;
          expect(captured.checkpoint).toEqual({ version: 1, provider: name, sessionId: `native-${name}`,
            worktreePath: f.options.worktreePath, workspacePath: f.expectedCwd });
          const before = structuredClone(captured);
          const resumed = await execution.resume({ snapshot: captured });
          expect(captured).toEqual(before);
          expect(f.start.mock.calls[1][0].command.cwd).toBe(f.expectedCwd);
          expect(f.start.mock.calls[1][0].command.argv.slice(-2)).toEqual([name === 'cursor' ? '--resume' : '--session', `native-${name}`]);
          expect(await resumed.waitForResult()).toMatchObject({ status: 'completed', sessionId: `native-${name}`, usage });
        }
      } finally { await f.sandbox.close(); }
    });
  });

  describe.each(['cursor', 'pi'] as const)('%s native cwd rejection', name => {
    it.each(['host', 'sibling', 'other-mount', 'mount-root'] as const)('rejects %s cwd in the actual sandbox path', async wrong => {
      const f = await containerHost(engine, name, 'custom', (_cwd, host) => ({
        host, sibling: '/workspace/repositories/other', 'other-mount': '/afk/session', 'mount-root': '/workspace',
      })[wrong]);
      try {
        const execution = await f.provider.createExecution(f.options);
        expect(await execution.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_SESSION_MISMATCH' } });
        expect(execution.sessionId).toBeUndefined();
        expect(execution.metadata.threadId).toBeUndefined();
        expect(await execution.captureSession()).toBeUndefined();
      } finally { await f.sandbox.close(); }
    });
  });
});

describe.each(['docker', 'podman'] as const)('container native results / %s', engine => {
  describe.each(['cursor', 'pi'] as const)('%s', name => {
    async function native(lines: (root: string) => unknown[], exit = 0, resume = false) {
      const f = await files(engine);
      await f.write(lines(f.root), exit);
      const provider = name === 'cursor' ? new CursorProvider() : new PiProvider();
      const execution = await provider.createExecution({
        worktreePath: f.root, sessionId: 'logical-agent-session', prompt: 'finish', generation: 1,
        signalType: 'goal_complete', executionMode: 'batch',
        sandbox: { worktreePath: f.root, workspacePath: f.root, startAgent: async options => f.start(options) },
        ...(resume ? { resume: { sessionId: `native-${name}`, generation: 0, summary: '', capturedAt: goal.timestamp,
          checkpoint: { version: 1, provider: name, sessionId: `native-${name}`, worktreePath: f.root } } } : {}),
      });
      return { ...f, execution };
    }

    it('retains final native usage, session and telemetry after the first completion', async () => {
      const f = await native(root => nativeLines(name, root));
      const result = await f.execution.waitForResult({ contextHighTokens: 1 });
      expect(result).toMatchObject({ status: 'completed', usage, sessionId: `native-${name}`, structuredOutput: goal });
      expect(f.execution.metadata.threadId).toBe(`native-${name}`);
      expect(await collectAgentTelemetry(f.execution, result, 'container')).toMatchObject({ sessionId: `native-${name}`, usage });
      expect(await f.execution.captureSession()).toMatchObject({ sessionId: `native-${name}`, usage,
        checkpoint: { provider: name, sessionId: `native-${name}`, worktreePath: f.root } });
      expect(f.provider.killContainer).not.toHaveBeenCalled();
    });

    it.each([false, true])('rejects a trailing native error despite completion (signal file: %s)', async signal => {
      const f = await native(root => [...nativeLines(name, root), ...nativeError(name)]);
      if (signal) await fs.writeFile(join(f.root, '.afk-signal.json'), JSON.stringify(goal));
      expect(await f.execution.waitForResult({ contextHighTokens: 1 })).toMatchObject({
        status: 'failed', usage, error: { code: 'AGENT_ERROR', message: 'native rejected' },
      });
    });

    it.each(['session', 'cwd'] as const)('validates trailing %s identity after completion', async mismatch => {
      const f = await native(root => [...nativeLines(name, root), name === 'cursor'
        ? { type: 'system', subtype: 'init', session_id: mismatch === 'session' ? 'other' : 'native-cursor', cwd: mismatch === 'cwd' ? join(root, 'other') : root }
        : { type: 'session', id: mismatch === 'session' ? 'other' : 'native-pi', cwd: mismatch === 'cwd' ? join(root, 'other') : root }]);
      const result = await f.execution.waitForResult();
      expect(result).toMatchObject({ status: 'failed', error: { code: 'NATIVE_SESSION_MISMATCH' } });
      expect(result.sessionId).toBeUndefined();
      expect(f.execution.metadata.threadId).toBeUndefined();
      expect(await f.execution.captureSession()).toBeUndefined();
    });

    it('prioritizes a nonzero exit over native errors, completion and context threshold', async () => {
      const f = await native(root => [...nativeLines(name, root), ...nativeError(name)], 42);
      await fs.writeFile(f.paths.errorPath, 'process failed');
      await fs.writeFile(join(f.root, '.afk-signal.json'), JSON.stringify(goal));
      expect(await f.execution.waitForResult({ contextHighTokens: 1 })).toMatchObject({
        status: 'failed', exitCode: 42, usage, error: { code: 'NON_ZERO_EXIT', message: 'process failed' },
      });
    });

    it('requires native confirmation on resume instead of using a logical session', async () => {
      const lines = name === 'cursor' ? [{ type: 'result', subtype: 'success', result: marker }]
        : [{ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: marker }] } }, { type: 'agent_settled' }];
      const f = await native(() => lines, 0, true);
      expect(await f.execution.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_SESSION_UNCONFIRMED' } });
      expect(f.execution.sessionId).toBeUndefined();
      expect(await f.execution.captureSession()).toBeUndefined();
    });

    it('does not complete from native progress text before a terminal result', async () => {
      const f = await native(root => name === 'cursor' ? [
        { type: 'system', subtype: 'init', session_id: 'native-cursor', cwd: root },
        { type: 'assistant', message: { content: [{ type: 'text', text: marker }] } },
      ] : nativeLines(name, root).filter(line => line.type !== 'agent_settled'));
      expect(await f.execution.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'MISSING_RESULT' } });
    });
  });
});

describe('container event and legacy boundaries', () => {
  it('consumes every event in order and accepts a provider result object', async () => {
    const f = await files();
    await f.write(['first', '', 'last']);
    const seen: string[] = [];
    const execution = f.start({ parseLine: line => {
      seen.push(line);
      return line === 'first' ? [{ type: 'result', result: marker }] : [
        { type: 'result', result: goal }, { type: 'usage', usage }, { type: 'session', sessionId: 'native-test' },
      ];
    } });
    expect(await execution.waitForResult()).toMatchObject({ status: 'completed', structuredOutput: goal, usage, sessionId: 'native-test' });
    expect(seen).toEqual(['first', 'last']);
    expect(execution.metadata.threadId).toBe('native-test');
  });

  it('does not let later success clear an earlier native error', async () => {
    const f = await files();
    await f.write(['events']);
    expect(await f.start({ parseLine: () => [
      { type: 'error', error: new Error('first failure') }, { type: 'result', result: marker }, { type: 'usage', usage },
    ] }).waitForResult()).toMatchObject({ status: 'failed', usage, error: { code: 'AGENT_ERROR', message: 'first failure' } });
  });

  it.each(['text', 'ignored'] as const)('does not promote %s output or a signal to a native result', async kind => {
    const f = await files();
    await f.write([marker]);
    await fs.writeFile(join(f.root, '.afk-signal.json'), JSON.stringify(goal));
    expect(await f.start({ parseLine: () => kind === 'text' ? [{ type: 'text', text: marker }] : [] }).waitForResult())
      .toMatchObject({ status: 'failed', error: { code: 'MISSING_RESULT' } });
  });

  it.each(['marker', 'signal'] as const)('accepts a legacy %s only after successful exit, without inventing native identity', async kind => {
    const f = await files();
    await f.write(kind === 'marker' ? [marker] : []);
    if (kind === 'signal') await fs.writeFile(join(f.root, '.afk-signal.json'), JSON.stringify(goal));
    const execution = f.start();
    expect(await execution.waitForResult()).toMatchObject({ status: 'completed', structuredOutput: goal });
    expect(execution.sessionId).toBeUndefined();
    expect(execution.metadata.threadId).toBeUndefined();
    expect(await execution.captureSession()).toBeUndefined();
  });

  it('does not complete from a marker or signal while the process is still running', async () => {
    const f = await files();
    await f.write([marker]);
    await fs.rm(f.paths.exitPath, { force: true });
    await fs.writeFile(join(f.root, '.afk-signal.json'), JSON.stringify(goal));
    expect(await f.start().waitForResult({ completionTimeoutMs: 20 })).toMatchObject({ status: 'timed_out' });
    expect(f.provider.killContainer).toHaveBeenCalledOnce();
  });

  it.each([`<goal_complete>invalid</goal_complete>`, `<goal_complete>{"type":"other"}</goal_complete>`, ''])('rejects invalid/missing legacy completion %s', async output => {
    const f = await files();
    await f.write([output]);
    expect(await f.start().waitForResult()).toMatchObject({ status: 'failed', error: { code: 'MISSING_RESULT' } });
  });

  it('preserves final usage on a missing-result failure even above the context threshold', async () => {
    const f = await files();
    await f.write(['usage']);
    expect(await f.start({ parseLine: () => [{ type: 'usage', usage }] }).waitForResult({ contextHighTokens: 1 }))
      .toMatchObject({ status: 'failed', usage, error: { code: 'MISSING_RESULT' } });
  });

  it.each(['claude-code', 'codex'] as const)('reuses %s tool summaries, including events after completion', async name => {
    const f = await files();
    const lines = name === 'codex' ? [
      { type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'private input' } },
      { type: 'item.completed', item: { id: 'tool', type: 'command_execution', exit_code: 7, aggregated_output: 'private output' } },
    ] : [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: 'private input' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: true, content: 'private output' }] } },
    ];
    await f.write([marker, ...lines, lines[1]]);
    const result = await f.start({ metadata: { provider: name, transport: 'process' },
      parseLine: line => line === marker ? [{ type: 'result', result: marker }] : [] }).waitForResult();
    expect(result.status).toBe('completed');
    expect(result.tools).toEqual([{ id: 'tool', name: name === 'codex' ? 'command_execution' : 'Bash', result: 'failed',
      ...(name === 'codex' ? { exitCode: 7 } : {}) }]);
    expect(JSON.stringify(result.tools)).not.toContain('private');
  });
});
