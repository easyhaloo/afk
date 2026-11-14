import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CursorProvider } from '../domain/agents/cursor.js';
import { PiProvider } from '../domain/agents/pi.js';
import type { AgentExecution, AgentStartOptions, SessionSnapshot } from '../domain/agents/types.js';
import type { Sandbox } from '../infrastructure/sandbox/types.js';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import type { SessionStoreChain } from './sessions/types.js';
import { BudgetManager } from './workflows/budget.js';
import { RunResourceScope } from './workflows/resource-scope.js';
import { createHandoffCoordinator, handoffDocPath } from './workflows/handoff.js';
import type { RunObserver } from '../observability/run-observer.js';
import { WorkflowRunner } from './workflow-engine.js';
import { StreamingAgentExecution } from '../infrastructure/sandbox/providers/streaming.js';

const resources: { root: string; children: ChildProcess[] }[] = [];
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const running = (child: ChildProcess) => {
  try { process.kill(child.pid!, 0); } catch { return false; }
  const state = execFileSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();
  return state.length > 0 && !state.startsWith('Z');
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    for (const child of resource.children) {
      if (alive(child)) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      expect(alive(child)).toBe(false);
    }
    console.info('batch lifecycle cleanup', JSON.stringify(resource.children.map(child => ({ pid: child.pid, exit: child.exitCode, signal: child.signalCode, alive: alive(child) }))));
    rmSync(resource.root, { recursive: true, force: true });
  }
});

async function fixture(options: {
  provider?: 'cursor' | 'pi'; native?: boolean; noResume?: boolean; failKill?: boolean; failOutput?: boolean;
  alwaysHigh?: boolean; maxHandoffs?: number; maxTokens?: number; failResume?: boolean;
  boundary?: 'capture' | 'persist' | 'load' | 'start'; cancel?: 'lease' | 'scope';
  streaming?: boolean;
  highRounds?: number;
  defaultCoordinator?: boolean;
  increasingUsage?: boolean;
  id?: string;
  duringInitialStart?: (scope: RunResourceScope) => Promise<void>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'afk-batch-handoff-'));
  const children: ChildProcess[] = [];
  resources.push({ root, children });
  execFileSync('git', ['init', '-q', '-b', 'fixture'], { cwd: root });
  writeFileSync(join(root, 'work.txt'), 'real fixture context\n');
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', 'work.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const provider = options.provider === 'pi' ? new PiProvider() : new CursorProvider();
  if (options.noResume) vi.spyOn(provider.capabilities, 'has').mockReturnValue(false);
  const events: string[] = [];
  const prompts: string[] = [];
  const commands: string[][] = [];
  const overlap: boolean[] = [];
  const ledgerAtStarts: ReturnType<BudgetManager['snapshot']>[] = [];
  const backlog = { claim: vi.fn(async () => null), transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}) };
  let snapshot: SessionSnapshot | undefined;
  let workflow: WorkflowRunner;
  const scope = new RunResourceScope({ repoRoot: root, baseBranch: 'fixture' });
  const cancel = async () => {
    if (options.cancel === 'lease') internals.leaseLost = true;
    if (options.cancel === 'scope') await scope.stopExecutions();
  };
  const chain = {
    saveFirst: vi.fn(async (input: { snapshot: SessionSnapshot }) => { snapshot = input.snapshot; events.push('save'); }),
    loadFirst: vi.fn(async () => {
      if (options.boundary === 'load') await cancel();
      return snapshot ? { snapshot, storeName: 'memory' } : undefined;
    }),
  } as unknown as SessionStoreChain;
  const startAgent = vi.fn(async (start: AgentStartOptions): Promise<AgentExecution> => {
    const generation = startAgent.mock.calls.length;
    if (generation > 1) {
      overlap.push(children.some(running));
      ledgerAtStarts.push(budget.snapshot());
    }
    if (generation > 1 && options.failResume && start.command.argv.some(arg => arg === '--resume' || arg === '--session')) {
      events.push('resume-start-failed');
      throw new Error('fixture native start failed');
    }
    prompts.push(start.prompt);
    commands.push(start.command.argv);
    const session = options.native === false ? '' : JSON.stringify(provider.name === 'cursor'
      ? { type: 'system', subtype: 'init', session_id: 'native-fixture' }
      : { type: 'session', version: 3, id: 'native-fixture' });
    const argv = [process.execPath, '-e', `process.stdin.resume(); process.stdout.write(${JSON.stringify(`${session}\nreal-output-${generation}\n`)}); setInterval(() => {}, 1000)`];
    const streaming = options.streaming ? new StreamingAgentExecution({ ...start,
      command: { argv, cwd: root }, worktreePath: root }) : undefined;
    streaming?.start();
    const child = streaming ? (streaming as unknown as { proc: ChildProcess }).proc
      : spawn(argv[0], argv.slice(1), { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.on('data', chunk => {
        output += chunk.toString();
        if (!streaming) for (const line of chunk.toString().split('\n')) if (line) start.parseLine?.(line);
        if (output.includes('real-output')) resolve();
      });
    });
    events.push(`start-${generation}`);
    const tokens = options.increasingUsage ? generation * 100 : 100;
    const execution: AgentExecution = {
      id: `fixture-${generation}`, metadata: start.metadata,
      waitForEvent: async () => null,
      waitForResult: async () => { events.push(`result-${generation}`); return { version: 1, runId: `fixture-${generation}`, provider: provider.name,
        status: generation <= (options.highRounds ?? 1) || options.alwaysHigh ? 'context_high' : 'completed', commits: [],
        usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens } }; },
      captureOutput: async () => {
        events.push(`capture-${generation}`);
        if (options.boundary === 'capture') await cancel();
        if (options.failOutput) throw new Error('fixture capture failed');
        if (!alive(child)) throw new Error('fixture capture after stop');
        return output;
      },
      captureSession: async () => undefined,
      interrupt: async () => { child.kill('SIGINT'); },
      kill: async () => {
        if (options.failKill) throw new Error('fixture cleanup failed');
        if (alive(child)) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
          events.push(`stop-${generation}`);
        }
      },
      resume: async () => { throw new Error('host resume forbidden'); },
    };
    if (streaming) {
      execution.captureOutput = captureOptions => streaming.captureOutput(captureOptions);
      execution.kill = async () => { await streaming.kill(); events.push(`stop-${generation}`); };
    }
    if (generation > 1 && options.boundary === 'start') await cancel();
    if (generation === 1) await options.duringInitialStart?.(scope);
    return execution;
  });
  const sandbox = { startAgent } as unknown as Sandbox;
  const tmux = new Proxy({}, { get: (_target, method) => vi.fn(async () => { throw new Error(`batch called tmux.${String(method)}`); }) });
  workflow = new WorkflowRunner({ backlog } as unknown as ProviderBundle, {
    observer: { record: vi.fn(async () => {}) } as unknown as RunObserver,
    ...(options.defaultCoordinator ? {} : { coordinatorFactory: createHandoffCoordinator }),
    agentProvider: provider, sandboxProvider: { name: 'local', capabilities: new Set() } as never,
    sessionStoreChain: () => chain, tmux: tmux as never,
  });
  const internals = workflow as unknown as {
    sandbox: Sandbox; activeBacklog: { id: string }; resourceScope: RunResourceScope; leaseLost: boolean;
    runPhase(input: unknown): Promise<{ completed: boolean }>;
    writeRuntimeDiagnostics(...input: unknown[]): Promise<void>;
  };
  internals.sandbox = sandbox;
  internals.activeBacklog = { id: options.id ?? '42' };
  internals.resourceScope = scope;
  vi.spyOn(internals, 'writeRuntimeDiagnostics').mockResolvedValue();
  const budget = new BudgetManager(options.maxHandoffs ?? 3, options.maxTokens ?? 1000000);
  const persisted: ReturnType<BudgetManager['snapshot']>[] = [];
  const persistBudget = vi.fn(async () => {
    persisted.push(budget.snapshot());
    if (budget.used > 0 && options.boundary === 'persist') await cancel();
  });
  const run = () => internals.runPhase({ iid: 42, session: 'afk-logical', wtPath: root,
    hardTimeoutMs: 10000, completionTimeoutMs: 10000, idleTimeoutMs: 5000, contextHighTokens: 100,
    budget, persistBudget, prompt: 'continue fixture work', signalType: 'goal_complete', executionMode: 'batch', completionKind: 'task' });
  return { root, sha, children, events, prompts, commands, overlap, ledgerAtStarts, backlog, budget, persisted, chain, startAgent, scope, run };
}

describe('batch context handoff lifecycle', () => {
  it.each(['github:fixture/repo#42', 'gitlab:fixture/subgroup/repo#42', '42'])(
    'selects earlier handoff documents using the complete work identity: %s', async id => {
      const host = await fixture({ id, highRounds: 2, native: false });
      const first = handoffDocPath(host.root, id, 1);
      const legacy = handoffDocPath(host.root, '42', 1);
      mkdirSync(dirname(first), { recursive: true });
      if (id !== '42') writeFileSync(legacy, 'a different legacy work identity');

      expect((await host.run()).completed).toBe(true);
      const prompt = host.prompts[2];
      expect(prompt).toContain(handoffDocPath(host.root, id, 2));
      const wildcard = /同目录 (handoff-[^\s]+?\*\.md)/.exec(prompt)?.[1];
      expect(wildcard).toBeDefined();
      const prefix = wildcard!.split('*')[0];
      const selected = readdirSync(dirname(first)).filter(name => name.startsWith(prefix) && name.endsWith('.md'));
      expect(selected).toContain(basename(first));
      if (id !== '42') expect(selected).not.toContain(basename(legacy));
    });

  it.each([
    { id: 'github:fixture/repo#42', native: false },
    { id: 'github:fixture/repo#42', native: true },
    { id: 'gitlab:fixture/subgroup/repo#42', native: false },
    { id: 'gitlab:fixture/subgroup/repo#42', native: true },
  ])('preserves canonical identity across output, doc and next prompt: %j', async options => {
    const host = await fixture(options);
    expect((await host.run()).completed).toBe(true);
    const doc = handoffDocPath(host.root, options.id, 1);
    expect(doc).toContain(`handoff-${encodeURIComponent(options.id)}-1.md`);
    const content = readFileSync(doc, 'utf8');
    expect(content).toContain(`# Handoff ${options.id}`);
    expect(content).toContain(host.sha);
    expect(content).toContain('real-output-1');
    expect(host.overlap).toEqual([false]);
    expect(host.budget.used).toBe(1);
    if (options.native) expect(host.prompts[1]).toBe(host.prompts[0]);
    else expect(host.prompts[1]).toContain(doc);
    expect(host.backlog.transition).not.toHaveBeenCalled();
  });

  it.each(['github:fixture/repo#42', 'gitlab:fixture/subgroup/repo#42'])('persists terminal recovery for canonical identity %s', async id => {
    const host = await fixture({ id, maxTokens: 100, alwaysHigh: true });
    expect((await host.run()).completed).toBe(false);
    expect(host.startAgent).toHaveBeenCalledTimes(1);
    expect(host.children.every(child => !alive(child))).toBe(true);
    const terminal = handoffDocPath(host.root, id, 1).replace(/-1\.md$/, '-terminal.md');
    expect(readFileSync(terminal, 'utf8')).toContain(`# Handoff ${id} (round terminal)`);
    expect(host.backlog.transition).toHaveBeenCalledWith(id, 'blocked', { reason: 'tokens' });
    expect(host.persisted.at(-1)).toEqual(host.budget.snapshot());
  });

  it.each([
    { operation: 'stop', highRounds: 0 }, { operation: 'finish', highRounds: 0 },
    { operation: 'stop', highRounds: 1 }, { operation: 'finish', highRounds: 1 },
  ])('owns cancellation before initial execution returns: %j', async options => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const host = await fixture({ highRounds: options.highRounds, duringInitialStart: async () => { entered(); await pending; } });
    const outcome = host.run().then(value => ({ value }), (error: Error) => ({ error: error.message }));
    await started;
    expect(host.children.some(alive)).toBe(true);
    if (options.operation === 'finish') await host.scope.finish({ status: 'failed' });
    else await host.scope.stopExecutions();
    release();
    expect(await outcome).toMatchObject({ error: expect.stringContaining('cancelled') });
    expect(host.children.every(child => !alive(child))).toBe(true);
    expect(host.startAgent).toHaveBeenCalledTimes(1);
    expect(host.events).not.toContain('result-1');
    expect(host.persisted).toEqual([]);
    expect(host.chain.saveFirst).not.toHaveBeenCalled();
    expect(host.backlog.transition).not.toHaveBeenCalled();
  });

  it('retains a late initial execution cleanup failure and prevents another start', async () => {
    const host = await fixture({ failKill: true, duringInitialStart: scope => scope.stopExecutions() });
    await expect(host.run()).rejects.toThrow('fixture cleanup failed');
    expect(host.startAgent).toHaveBeenCalledTimes(1);
    expect(host.events).not.toContain('result-1');
  });

  it('uses the real coordinator on the production default constructor path', async () => {
    const host = await fixture({ defaultCoordinator: true, native: false });
    expect((await host.run()).completed).toBe(true);
    expect(host.overlap).toEqual([false]);
    expect(readFileSync(handoffDocPath(host.root, '42', 1), 'utf8')).toContain('real-output-1');
    expect(host.prompts[1]).toContain(handoffDocPath(host.root, '42', 1));
  });

  it('reserves the last handoff before native startup and deduplicates cumulative totalTokens', async () => {
    const host = await fixture({ maxHandoffs: 1, increasingUsage: true });
    expect((await host.run()).completed).toBe(true);
    expect(host.ledgerAtStarts).toEqual([{ used: 1, tokens: 100, sessions: { 'native-fixture': 100 } }]);
    expect(host.budget.snapshot()).toEqual({ used: 1, tokens: 200, sessions: { 'native-fixture': 200 } });
    expect(host.persisted.at(-1)).toEqual(host.budget.snapshot());
  });
  it.each(['cursor', 'pi'] as const)('stops old %s execution before native resume and preserves its provider', async provider => {
    const host = await fixture({ provider });
    expect(await host.run()).toEqual({ completed: true, output: undefined });
    expect(host.overlap).toEqual([false]);
    expect(host.events.indexOf('stop-1')).toBeLessThan(host.events.indexOf('start-2'));
    expect(host.commands[1]).toContain(provider === 'cursor' ? '--resume' : '--session');
    expect(host.chain.saveFirst).toHaveBeenCalledWith(expect.objectContaining({ provider }));
    expect(host.prompts[1]).toBe(host.prompts[0]);
    expect(host.budget.used).toBe(1);
  });

  it.each(['cursor', 'pi'] as const)('uses the real streaming host kill boundary for %s', async provider => {
    const host = await fixture({ provider, streaming: true });
    expect((await host.run()).completed).toBe(true);
    expect(host.overlap).toEqual([false]);
    expect(running(host.children[0])).toBe(false);
  });

  it.each([true, false])('references only persisted docs across multiple boundaries (native=%s)', async native => {
    const host = await fixture({ native, highRounds: 2 });
    expect((await host.run()).completed).toBe(true);
    expect(host.budget.used).toBe(2);
    expect(host.overlap).toEqual([false, false]);
    for (const generation of [1, 2]) expect(existsSync(handoffDocPath(host.root, '42', generation))).toBe(true);
    if (native) expect(host.prompts).toEqual([host.prompts[0], host.prompts[0], host.prompts[0]]);
    else expect(host.prompts[2]).toContain(handoffDocPath(host.root, '42', 2));
  });

  it.each([{ native: false }, { noResume: true }])('writes a real recovery doc and starts a fresh batch without native resume: %j', async options => {
    const host = await fixture(options);
    expect((await host.run()).completed).toBe(true);
    const doc = handoffDocPath(host.root, '42', 1);
    expect(existsSync(doc)).toBe(true);
    const content = readFileSync(doc, 'utf8');
    expect(content).toContain('real-output-1');
    expect(content).toContain(host.sha);
    expect(content).toContain('fixture');
    expect(host.prompts[1]).toContain(doc);
    expect(host.commands[1]).not.toContain('--resume');
    expect(host.overlap).toEqual([false]);
    expect(host.budget.used).toBe(1);
    expect(host.persisted.some(state => state.used === 1)).toBe(true);
  });

  it.each([{ maxHandoffs: 1, reason: 'budget' }, { maxTokens: 100, reason: 'tokens' }])('stops and persists terminal $reason without a fresh start', async options => {
    const host = await fixture({ ...options, native: false, alwaysHigh: true });
    expect((await host.run()).completed).toBe(false);
    expect(host.children).toHaveLength(options.reason === 'budget' ? 2 : 1);
    expect(host.children.every(child => !alive(child))).toBe(true);
    const doc = handoffDocPath(host.root, '42', 1).replace(/-1\.md$/, '-terminal.md');
    expect(readFileSync(doc, 'utf8')).toContain('real-output');
    expect(host.backlog.transition).toHaveBeenCalledWith('42', 'blocked', { reason: options.reason });
    expect(host.backlog.setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
  });

  it('rejects a failed cleanup and retains its failure and recovery doc', async () => {
    const host = await fixture({ failKill: true });
    await expect(host.run()).rejects.toThrow('fixture cleanup failed');
    expect(host.startAgent).toHaveBeenCalledTimes(1);
    expect(readFileSync(handoffDocPath(host.root, '42', 1), 'utf8')).toContain('real-output-1');
    expect(host.backlog.transition).toHaveBeenCalledWith('42', 'blocked', expect.objectContaining({ reason: expect.stringContaining('fixture cleanup failed') }));
  });

  it('still stops the old execution when capture fails', async () => {
    const host = await fixture({ failOutput: true });
    await expect(host.run()).rejects.toThrow('fixture capture failed');
    expect(host.children.every(child => !alive(child))).toBe(true);
    expect(host.startAgent).toHaveBeenCalledTimes(1);
  });

  it('falls back after a failed native start within one reserved handoff', async () => {
    const host = await fixture({ failResume: true, maxHandoffs: 1 });
    expect((await host.run()).completed).toBe(true);
    expect(host.overlap).toEqual([false, false]);
    expect(host.budget.used).toBe(1);
    expect(host.prompts[1]).toContain(handoffDocPath(host.root, '42', 1));
  });

  it.each(['lease', 'scope'] as const)('refuses startup after %s loss during resume preflight', async cancel => {
    const host = await fixture({ cancel, boundary: 'load' });
    await expect(host.run()).rejects.toThrow(/lease lost|cancelled/);
    expect(host.startAgent).toHaveBeenCalledTimes(1);
    expect(host.children.every(child => !alive(child))).toBe(true);
  });

  it.each([
    { cancel: 'lease', boundary: 'persist' }, { cancel: 'scope', boundary: 'persist' },
    { cancel: 'lease', boundary: 'start' }, { cancel: 'scope', boundary: 'start' },
    { cancel: 'lease', boundary: 'capture' }, { cancel: 'scope', boundary: 'capture' },
  ] as const)('cleans all owned processes on $cancel cancellation during $boundary', async options => {
    const host = await fixture(options);
    await expect(host.run()).rejects.toThrow(/lease lost|cancelled|capture after stop/);
    expect(host.children).toHaveLength(options.boundary === 'start' ? 2 : 1);
    expect(host.children.every(child => !alive(child))).toBe(true);
  });
});
