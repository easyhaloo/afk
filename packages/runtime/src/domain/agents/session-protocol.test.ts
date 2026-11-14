import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorProvider } from './cursor.js';
import { PiProvider } from './pi.js';
import { StreamingAgentExecution } from '../../infrastructure/sandbox/providers/streaming.js';
import type { AgentExecution, AgentExecutionOptions, AgentStartOptions, SessionSnapshot } from './types.js';

const worktreePath = '/tmp/agent-protocol-fixture';
const complete = '<goal_complete>{"type":"goal_complete","summary":"fixture"}</goal_complete>';

function snapshot(provider: string, sessionId = 'native-session-1'): SessionSnapshot {
  return {
    sessionId,
    generation: 3,
    checkpoint: { version: 1, provider, sessionId, worktreePath },
    summary: 'previous generation',
    capturedAt: '2026-11-13T00:00:00.000Z',
  };
}

function fixtureHost() {
  const starts: AgentStartOptions[] = [];
  const executions: AgentExecution[] = [];
  const startAgent = vi.fn(async (start: AgentStartOptions): Promise<AgentExecution> => {
    starts.push(start);
    const execution: AgentExecution = {
      id: `fixture-${starts.length}`,
      sessionId: 'afk-logical-session',
      metadata: { ...start.metadata },
      waitForEvent: async () => null,
      waitForResult: async () => ({ version: 1, runId: 'fixture', status: 'completed', provider: 'fixture', commits: [] }),
      interrupt: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      captureOutput: async () => 'bounded fixture output',
      captureSession: async () => ({ ...snapshot('wrong'), checkpoint: null }),
      resume: vi.fn(async () => { throw new Error('host resume must not be used'); }),
    };
    executions.push(execution);
    return execution;
  });
  const options: AgentExecutionOptions = {
    sandbox: { worktreePath, workspacePath: worktreePath, startAgent },
    worktreePath,
    sessionId: 'afk-logical-session',
    generation: 3,
    prompt: 'Continue the controlled fixture',
    signalType: 'goal_complete',
    executionMode: 'batch',
  };
  const emit = (index: number, event: unknown) => starts[index].parseLine!(JSON.stringify(event));
  return { starts, executions, startAgent, options, emit };
}

const providers = [
  { name: 'cursor', create: () => new CursorProvider(), flag: '--resume', header: (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId, cwd: worktreePath }) },
  { name: 'pi', create: () => new PiProvider(), flag: '--session', header: (sessionId: string) => ({ type: 'session', version: 3, id: sessionId, cwd: worktreePath }) },
];

describe.each(providers)('$name explicit native session contract', ({ name, create, flag, header }) => {
  it.each([-1, 3, 20, Number.MAX_SAFE_INTEGER + 1])('rejects non-successor resume generation %s before starting the host', async generation => {
    const host = fixtureHost();
    await expect(create().createExecution({ ...host.options, generation, resume: snapshot(name) })).rejects.toThrow(/generation/i);
    expect(host.startAgent).not.toHaveBeenCalled();
  });

  it('sends the continuation prompt when resuming a captured execution', async () => {
    const host = fixtureHost();
    const execution = await create().createExecution(host.options);
    host.emit(0, header('native-continued'));
    const captured = (await execution.captureSession())!;
    await execution.kill();
    await execution.resume({ snapshot: captured, prompt: 'CONTINUATION PROMPT' });
    expect(host.starts[1].prompt).toBe('CONTINUATION PROMPT');
    expect(host.starts[1].generation).toBe(captured.generation + 1);
  });

  it('accepts an observed zero generation checkpoint used by the remote protocol', async () => {
    const host = fixtureHost();
    const provider = create();
    const execution = await provider.createExecution({ ...host.options, generation: 0 });
    host.emit(0, header('native-generation-zero'));
    const snapshot = (await execution.captureSession())!;
    expect(snapshot.generation).toBe(0);
    await expect(provider.restoreSession({ snapshot, worktreePath })).resolves.toBeUndefined();
    await expect(provider.restoreSession({ snapshot: { ...snapshot, generation: -1 }, worktreePath })).rejects.toThrow(/snapshot/);
  });

  it('keeps a fresh logical session distinct from native resume', async () => {
    const host = fixtureHost();
    await create().createExecution({ ...host.options, generation: 9 });
    expect(host.starts[0].command.argv).not.toContain(flag);
    expect(host.starts[0].command.argv).not.toContain(host.options.sessionId);
  });

  it('binds command/native cwd to the sandbox while preserving host checkpoint provenance', async () => {
    const host = fixtureHost();
    const workspacePath = '/workspace/repositories/api';
    host.options.sandbox = { ...host.options.sandbox, workspacePath };
    const provider = create();
    const fresh = await provider.createExecution(host.options);
    expect(host.starts[0].command.cwd).toBe(workspacePath);
    host.emit(0, { ...header('native-mapped'), cwd: workspacePath });
    expect(await fresh.waitForResult()).toMatchObject({ status: 'completed', sessionId: 'native-mapped' });
    const captured = (await fresh.captureSession())!;
    expect(captured.checkpoint).toEqual({ version: 1, provider: name, sessionId: 'native-mapped', worktreePath, workspacePath });
    const before = structuredClone(captured);
    const resumed = await fresh.resume({ snapshot: captured });
    expect(captured).toEqual(before);
    expect(host.starts[1].command.cwd).toBe(workspacePath);
    expect(host.starts[1].command.argv.slice(-2)).toEqual([flag, 'native-mapped']);
    host.emit(1, { ...header('native-mapped'), cwd: workspacePath });
    expect(await resumed.waitForResult()).toMatchObject({ status: 'completed', sessionId: 'native-mapped' });
  });

  it.each(['host', 'sibling', 'other-mount', 'relative'] as const)('rejects %s cwd instead of accepting multiple path namespaces', async wrong => {
    const host = fixtureHost();
    host.options.sandbox = { ...host.options.sandbox, workspacePath: '/workspace/repo' };
    const execution = await create().createExecution(host.options);
    const cwd = { host: worktreePath, sibling: '/workspace/other', 'other-mount': '/afk/session', relative: './repo' }[wrong];
    host.emit(0, { ...header('native-wrong-cwd'), cwd });
    expect(await execution.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_SESSION_MISMATCH' } });
    expect(execution.sessionId).toBeUndefined();
    expect(execution.metadata.threadId).toBeUndefined();
    expect(await execution.captureSession()).toBeUndefined();
  });

  it.each(['missing', 'changed', 'invalid', 'foreign-host'] as const)('rejects %s checkpoint provenance before launching a mapped resume', async wrong => {
    const host = fixtureHost();
    host.options.sandbox = { ...host.options.sandbox, workspacePath: '/workspace/repo' };
    const captured = snapshot(name);
    captured.checkpoint = { ...(captured.checkpoint as object),
      ...(wrong === 'missing' ? {} : { workspacePath: wrong === 'invalid' ? 42 : '/workspace/repo' }),
      ...(wrong === 'foreign-host' ? { worktreePath: '/other/host' } : {}),
    };
    if (wrong === 'changed') host.options.sandbox = { ...host.options.sandbox, workspacePath: '/workspace/custom' };
    await expect(create().createExecution({ ...host.options, generation: 4, resume: captured })).rejects.toThrow(/snapshot|workspace|worktree/i);
    expect(host.startAgent).not.toHaveBeenCalled();
  });

  it('rejects a request for a worktree outside the bound sandbox scope', async () => {
    const host = fixtureHost();
    host.options.sandbox = { ...host.options.sandbox, workspacePath: '/workspace/repo' };
    await expect(create().createExecution({ ...host.options, worktreePath: '/unrelated/host' })).rejects.toThrow(/worktree|workspace/i);
    expect(host.startAgent).not.toHaveBeenCalled();
  });

  it('preserves the server-side execution-path request and the remote delegation contract', async () => {
    const host = fixtureHost();
    host.options.sandbox = { ...host.options.sandbox, workspacePath: '/workspace/repo' };
    const provider = create();
    const execution = await provider.createExecution({ ...host.options, worktreePath: '/workspace/repo' });
    host.emit(0, { ...header('native-server'), cwd: '/workspace/repo' });
    const captured = (await execution.captureSession())!;
    expect(captured.checkpoint).toEqual({ version: 1, provider: name, sessionId: 'native-server', worktreePath, workspacePath: '/workspace/repo' });
    await expect(provider.restoreSession({ snapshot: captured, worktreePath: '/workspace/repo' })).resolves.toBeUndefined();
    await execution.resume({ snapshot: captured });
    expect(host.starts[1].command.argv.slice(-2)).toEqual([flag, 'native-server']);
    const delegated = host.executions[0];
    const startProviderExecution = vi.fn(async () => delegated);
    await expect(provider.createExecution({ ...host.options, sandbox: { ...host.options.sandbox, startProviderExecution } })).resolves.toBe(delegated);
    expect(startProviderExecution).toHaveBeenCalledWith(name, expect.objectContaining({ worktreePath }));
    expect(host.starts).toHaveLength(2);
  });

  it('rejects another host mount with the same execution path on server-side native resume', async () => {
    const host = fixtureHost();
    host.options.sandbox = { ...host.options.sandbox, workspacePath: '/workspace/repo' };
    const provider = create();
    const execution = await provider.createExecution({ ...host.options, worktreePath: '/workspace/repo' });
    host.emit(0, { ...header('native-server'), cwd: '/workspace/repo' });
    const captured = (await execution.captureSession())!;
    const other = fixtureHost();
    other.options.sandbox = { ...other.options.sandbox, worktreePath: '/other/host', workspacePath: '/workspace/repo' };
    await expect(provider.createExecution({ ...other.options, worktreePath: '/workspace/repo', generation: 4, resume: captured }))
      .rejects.toThrow(/worktree|workspace|snapshot/i);
    expect(other.startAgent).not.toHaveBeenCalled();
  });

  it.each(['failed', 'completed'] as const)('preserves a real nonzero exit from a %s source while invalidating mismatched identity', async status => {
    const host = fixtureHost();
    const execution = await create().createExecution(host.options);
    host.emit(0, header('confirmed-native'));
    host.emit(0, header('wrong-native'));
    host.executions[0].waitForResult = async () => ({ version: 1, runId: 'fixture', provider: name, status,
      exitCode: 42, error: { code: 'NON_ZERO_EXIT', message: 'actual process exit' }, commits: [] });
    expect(await execution.waitForResult()).toMatchObject({ status: 'failed', exitCode: 42,
      error: { code: 'NON_ZERO_EXIT', message: 'actual process exit' } });
    expect(execution.sessionId).toBeUndefined();
    expect(execution.metadata.threadId).toBeUndefined();
    expect(await execution.captureSession()).toBeUndefined();
  });

  it('uses executionMode as the authority for batch and interactive commands', () => {
    const provider = create();
    const host = fixtureHost();
    const interactive = provider.buildCommand({ ...host.options, executionMode: 'interactive', interactive: false }).argv;
    expect(interactive).toEqual([name === 'cursor' ? 'cursor-agent' : 'pi']);
    const batch = provider.buildCommand({ ...host.options, executionMode: 'batch', interactive: true }).argv;
    expect(batch).toEqual(name === 'cursor'
      ? ['cursor-agent', '--print', '--output-format', 'stream-json']
      : ['pi', '--print', '--mode', 'json']);
  });

  it('rejects old synthetic snapshots instead of treating no-op restore as success', async () => {
    await expect(create().restoreSession({ snapshot: { ...snapshot(name), checkpoint: null }, worktreePath })).rejects.toThrow(/native session snapshot/i);
  });

  it('rejects foreign provider, worktree, and mismatched native identity', async () => {
    const provider = create();
    for (const invalid of [snapshot('foreign'), { ...snapshot(name), sessionId: 'different' }, { ...snapshot(name), checkpoint: { version: 1, provider: name, sessionId: 'native-session-1', worktreePath: '/elsewhere' } }]) {
      await expect(provider.restoreSession({ snapshot: invalid, worktreePath })).rejects.toThrow(/native session snapshot/i);
    }
  });

  it('captures only an observed native session rather than the host pane snapshot', async () => {
    const provider = create();
    const host = fixtureHost();
    const execution = await provider.createExecution(host.options);
    expect(await execution.captureSession()).toBeUndefined();
    host.emit(0, header('native-observed'));
    expect(execution.metadata.threadId).toBe('native-observed');
    expect(execution.sessionId).toBe('native-observed');
    expect(await execution.captureSession()).toMatchObject({ sessionId: 'native-observed', generation: 3, checkpoint: { version: 1, provider: name, sessionId: 'native-observed', worktreePath } });
    await expect(provider.captureSession({ sessionId: host.options.sessionId, worktreePath })).rejects.toThrow(/execution/i);
  });

  it('validates restore before launch and carries the explicit native ID into the command', async () => {
    const provider = create();
    const host = fixtureHost();
    const restore = vi.spyOn(provider, 'restoreSession');
    const execution = await provider.createExecution({ ...host.options, generation: 4, resume: snapshot(name) });
    expect(restore).toHaveBeenCalledWith({ snapshot: snapshot(name), worktreePath });
    expect(host.starts[0].command.argv.slice(-2)).toEqual([flag, 'native-session-1']);
    expect(await execution.captureSession()).toBeUndefined();
    host.emit(0, header('native-session-1'));
    expect((await execution.waitForResult()).status).toBe('completed');
  });

  it('rejects invalid explicit resume without starting the host', async () => {
    const host = fixtureHost();
    await expect(create().createExecution({ ...host.options, resume: snapshot('foreign') })).rejects.toThrow(/native session snapshot/i);
    expect(host.startAgent).not.toHaveBeenCalled();
  });

  it('rejects a CLI that starts a different session or never confirms resume', async () => {
    const provider = create();
    const wrong = fixtureHost();
    const mismatched = await provider.createExecution({ ...wrong.options, generation: 4, resume: snapshot(name) });
    wrong.emit(0, header('different-session'));
    expect(await mismatched.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_SESSION_MISMATCH' } });
    expect(await mismatched.captureSession()).toBeUndefined();
    expect(wrong.executions[0].kill).toHaveBeenCalled();
    const missing = fixtureHost();
    const unconfirmed = await provider.createExecution({ ...missing.options, generation: 4, resume: snapshot(name) });
    expect(await unconfirmed.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_SESSION_UNCONFIRMED' } });
    expect(missing.executions[0].kill).toHaveBeenCalled();
  });

  it('keeps parser identity and restore intent isolated between concurrent launches', async () => {
    const provider = create();
    const host = fixtureHost();
    const [first, second] = await Promise.all([
      provider.createExecution({ ...host.options, generation: 4, resume: snapshot(name, 'native-first') }),
      provider.createExecution({ ...host.options, generation: 4, resume: snapshot(name, 'native-second') }),
    ]);
    host.emit(1, header('native-second'));
    host.emit(0, header('native-first'));
    expect((await first.captureSession())?.sessionId).toBe('native-first');
    expect((await second.captureSession())?.sessionId).toBe('native-second');
    const fresh = await provider.createExecution(host.options);
    expect(host.starts[2].command.argv).not.toContain(flag);
    expect(await fresh.captureSession()).toBeUndefined();
  });

  it('discards a snapshot if native identity becomes invalid during output capture', async () => {
    const host = fixtureHost();
    const execution = await create().createExecution(host.options);
    host.emit(0, header('native-before-capture'));
    let release!: (output: string) => void;
    host.executions[0].captureOutput = () => new Promise(resolve => { release = resolve; });
    const capturing = execution.captureSession();
    host.emit(0, header('different-during-capture'));
    release('fixture output');
    expect(await capturing).toBeUndefined();
  });

  it('execution.resume launches the same native session with the next generation', async () => {
    const provider = create();
    const host = fixtureHost();
    const execution = await provider.createExecution(host.options);
    host.emit(0, header('native-observed'));
    const captured = (await execution.captureSession())!;
    const resumed = await execution.resume({ snapshot: captured });
    expect(host.starts[1].generation).toBe(4);
    expect(host.starts[1].command.argv.slice(-2)).toEqual([flag, 'native-observed']);
    host.emit(1, header('native-observed'));
    expect(resumed.metadata.threadId).toBe('native-observed');
  });

  it('carries a native checkpoint through fresh and resumed controlled OS processes', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-protocol-')));
    const running: AgentExecution[] = [];
    const starts: AgentStartOptions[] = [];
    try {
      const script = `
        const { name, flag, argv, complete } = JSON.parse(process.argv[1]);
        const resume = argv.indexOf(flag);
        const sessionId = resume < 0 ? 'native-from-fixture' : argv[resume + 1];
        const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
        if (name === 'cursor') {
          emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });
          emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: complete,
            usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 } });
        } else {
          emit({ type: 'session', version: 3, id: sessionId, cwd: process.cwd() });
          emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: complete }],
            usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 }, stopReason: 'stop' } });
          emit({ type: 'agent_end', messages: [], willRetry: false });
          emit({ type: 'agent_settled', aborted: false });
        }
      `;
      const startAgent = async (start: AgentStartOptions) => {
        starts.push(start);
        const execution = new StreamingAgentExecution({
          command: { argv: [process.execPath, '-e', script, JSON.stringify({ name, flag, argv: start.command.argv, complete })], cwd: directory },
          worktreePath: directory,
          sessionId: 'afk-logical-session',
          prompt: start.prompt,
          signalType: start.signalType,
          metadata: start.metadata,
          parseLine: start.parseLine,
        });
        running.push(execution);
        execution.start();
        return execution;
      };
      const host = fixtureHost();
      const provider = create();
      const fresh = await provider.createExecution({ ...host.options, worktreePath: directory,
        sandbox: { startAgent, worktreePath: directory, workspacePath: directory } });
      expect(await fresh.waitForResult({ completionTimeoutMs: 3000 })).toMatchObject({ status: 'completed', sessionId: 'native-from-fixture', usage: { inputTokens: 15, outputTokens: 4, totalTokens: 19 } });
      const captured = (await fresh.captureSession())!;
      const resumed = await fresh.resume({ snapshot: captured });
      expect(await resumed.waitForResult({ completionTimeoutMs: 3000 })).toMatchObject({ status: 'completed', sessionId: 'native-from-fixture' });
      expect(starts[0].command.argv).not.toContain(flag);
      expect(starts[1].command.argv.slice(-2)).toEqual([flag, 'native-from-fixture']);
      expect((await resumed.captureSession())?.generation).toBe(4);
    } finally {
      await Promise.all(running.map(execution => execution.kill()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('native protocol conversion', () => {
  it('converts Cursor terminal session, usage and error without treating assistant progress as a result', () => {
    const provider = new CursorProvider();
    expect(provider.parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-cursor', cwd: worktreePath }))).toContainEqual({ type: 'session', sessionId: 'native-cursor', worktreePath });
    expect(provider.parseLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: complete }] } }))).not.toContainEqual(expect.objectContaining({ type: 'result' }));
    expect(provider.parseLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-cursor', result: complete, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 } }))).toEqual(expect.arrayContaining([
      { type: 'session', sessionId: 'native-cursor' }, { type: 'usage', usage: { inputTokens: 15, outputTokens: 4, totalTokens: 19 } }, { type: 'result', result: complete },
    ]));
    const errors = provider.parseLine(JSON.stringify({ type: 'result', is_error: true, result: 'native failure' }));
    expect(errors).toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(errors).not.toContainEqual(expect.objectContaining({ type: 'result' }));
  });

  it('waits for Pi agent_settled, accumulates authoritative assistant usage once, and ignores tool/user messages', async () => {
    const host = fixtureHost();
    await new PiProvider().createExecution(host.options);
    expect(host.emit(0, { type: 'message_end', message: { role: 'user', content: complete } })).toEqual([]);
    const first = host.emit(0, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'tool reasoning' }], stopReason: 'toolUse', usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16 } } });
    expect(first).toContainEqual({ type: 'usage', usage: { inputTokens: 14, outputTokens: 2, totalTokens: 16 } });
    const final = host.emit(0, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: complete }], stopReason: 'stop', usage: { input: 5, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 11 } } });
    expect(final).not.toContainEqual(expect.objectContaining({ type: 'result' }));
    expect(final).toContainEqual({ type: 'usage', usage: { inputTokens: 21, outputTokens: 6, totalTokens: 27 } });
    expect(host.emit(0, { type: 'agent_end', messages: [], willRetry: false })).toEqual([]);
    expect(host.emit(0, { type: 'agent_settled', aborted: false })).toEqual([{ type: 'result', result: complete }]);
  });

  it('does not publish a Pi retry candidate as a successful terminal result', async () => {
    const host = fixtureHost();
    await new PiProvider().createExecution(host.options);
    host.emit(0, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: complete }], stopReason: 'error', errorMessage: 'retry me' } });
    expect(host.emit(0, { type: 'agent_end', messages: [], willRetry: true })).toEqual([]);
    host.emit(0, { type: 'agent_start' });
    host.emit(0, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }], stopReason: 'stop' } });
    expect(host.emit(0, { type: 'agent_settled', aborted: false })).toEqual([{ type: 'result', result: 'final' }]);
  });

  it.each(['error', 'aborted', 'length'])('surfaces a Pi %s instead of accepting completion-like text', async stopReason => {
    const host = fixtureHost();
    await new PiProvider().createExecution(host.options);
    host.emit(0, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: complete }], stopReason, errorMessage: 'native terminal failure' } });
    const events = host.emit(0, { type: 'agent_settled', aborted: stopReason === 'aborted' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'result' }));
  });
});
