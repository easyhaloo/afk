/**
 * Regression tests for WorkflowRunner cleanup control flow.
 *
 * Each explicit terminal path owns its cleanup (no _cleanupType state
 * machine, no finally-driven GitHub updates):
 *  - timeout path: handleTimeout posts the timeout comment + mode::hitl,
 *    tears down the session, returns {success:false}.
 *  - handoff path: handler self-cleans; run() adds no crash comment.
 *  - success path: autoWrapup removes the worktree (force), returns {success:true, url}.
 *
 * Strategy: stub runBody to drive each path (or run the real handler), then
 * exercise the real run(). tracker is injected; tmux/worktree are overwritten
 * via the instance. No module mocking.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { rm } from 'fs/promises';
import { WorkflowRunner } from '../src/lib/workflows';

// Mock child_process.spawn globally for this file so the default
// ProjectResolverModule (always loaded by loadModules as a core module)
// doesn't try to spawn a real `zsh -i -c 'j ...'` against the test env.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));
import { spawn } from 'child_process';

// Mock the project-resolver module itself. We want to test onInit wiring in
// isolation — the real ProjectResolverModule chdir's the test process and
// would tangle with whatever the surrounding code is doing.
vi.mock('../src/lib/modules/project-resolver', () => ({
  default: () => ({
    name: 'project-resolver',
    onInit: async () => {},
    onCleanup: async () => {},
  }),
}));

function mockSpawnOnce(stdout: string, exitCode = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    child.stdout.emit('data', stdout);
    child.emit('close', exitCode);
  });
  return child;
}

const LOG_DIR = '/tmp/afk-workflows-test';

function makeRunner() {
  const tracker = {
    addComment: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  } as any;

  const runner = new WorkflowRunner(tracker) as any;
  runner.tmux = {
    capturePane: vi.fn().mockResolvedValue('pane snapshot'),
    killSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
  };
  runner.worktree = {
    updateStatus: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  runner.logDir = LOG_DIR;
  return { runner, tracker };
}

const RUN_OPTS = { iid: 42, session: 'sess', targetBranch: 'main', baseBranch: 'main' };

describe('WorkflowRunner cleanup control flow', () => {
  afterEach(async () => {
    await rm(LOG_DIR, { recursive: true, force: true });
  });

  it('timeout path: posts timeout comment + mode::hitl and returns {success:false}', async () => {
    const { runner, tracker } = makeRunner();
    runner.runBody = async function () {
      await this.handleTimeout(42, '/tmp/wt', 'sess', 60000);
      return { success: false };
    };

    const result = await runner.run(RUN_OPTS);

    expect(result).toEqual({ success: false });
    expect(tracker.addComment).toHaveBeenCalledWith(42, expect.stringContaining('afk-event: timeout'));
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'mode::hitl');
    expect(tracker.removeLabel).toHaveBeenCalledWith(42, 'stage::afk-in-progress');
    // Failure path keeps the worktree (marked failed, not removed).
    expect(runner.worktree.updateStatus).toHaveBeenCalledWith(42, 'failed');
    expect(runner.worktree.cleanup).not.toHaveBeenCalled();
  });

  it('explicit failure path (handoff): no crash comment from run()', async () => {
    const { runner, tracker } = makeRunner();
    runner.runBody = async function () {
      // Handoff handlers clean up after themselves; nothing left for run().
      return { success: false };
    };

    const result = await runner.run(RUN_OPTS);

    expect(result).toEqual({ success: false });
    expect(tracker.addComment).not.toHaveBeenCalled();
    expect(tracker.addLabel).not.toHaveBeenCalled();
  });

  it('success path: autoWrapup removes worktree (force) and returns {success:true, url}', async () => {
    const { runner, tracker } = makeRunner();
    runner.pushBranch = vi.fn().mockResolvedValue(undefined);
    runner.createMR = vi.fn().mockResolvedValue('https://example.com/mr/1');
    runner.runBody = async function () {
      return await this.autoWrapup(42, '/tmp/wt', 'sess', 'main');
    };

    const result = await runner.run(RUN_OPTS);

    expect(result).toEqual({ success: true, url: 'https://example.com/mr/1' });
    expect(runner.tmux.killSession).toHaveBeenCalledWith('sess');
    expect(runner.tmux.closeSession).toHaveBeenCalled();
    expect(runner.worktree.cleanup).toHaveBeenCalledWith(42, true);
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'stage::qa');
    expect(tracker.addComment).not.toHaveBeenCalled();
  });
});

/**
 * WorkflowRunner.onInit wiring: the init phase must run before worktree
 * creation, must throw on failure (Q-K option 1: init is infrastructure),
 * and must receive projectName from RunnerOptions.
 *
 * These tests bypass loadModules() (which always pulls in the real
 * ProjectResolverModule, whose JumpProjectResolver spawns zsh against the
 * test env and hangs). We install modules directly and drive runInitHooks
 * through the same code path run() uses.
 */
describe('WorkflowRunner.onInit phase', () => {
  beforeEach(async () => {
    const { _resetRegistry } = await import('../src/lib/modules/_registry');
    _resetRegistry();
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it('fires onInit hooks before worktree.create, in registration order', async () => {
    const calls: string[] = [];
    const { defineModule } = await import('../src/lib/modules/_registry');
    defineModule(() => ({
      name: 'init-a',
      async onInit() { calls.push('onInit:a'); },
    }));
    defineModule(() => ({
      name: 'init-b',
      async onInit() { calls.push('onInit:b'); },
    }));

    const { runner } = makeRunner();
    runner.worktree = {
      create: vi.fn(async () => { calls.push('worktree.create'); throw new Error('stop'); }),
      updateStatus: vi.fn(),
      cleanup: vi.fn(),
    };

    await expect(runner.run({
      ...RUN_OPTS,
      ext: ['init-a', 'init-b'],
    })).rejects.toThrow('stop');

    // project-resolver (always-loaded core, mocked as no-op above) runs first.
    // Then init-a, init-b, then worktree.create.
    expect(calls).toEqual(['onInit:a', 'onInit:b', 'worktree.create']);
  });

  it('onInit failure throws and aborts the run (Q-K option 1)', async () => {
    const { defineModule } = await import('../src/lib/modules/_registry');
    defineModule(() => ({
      name: 'init-fail',
      async onInit() { throw new Error('init broken'); },
    }));

    const { runner, tracker } = makeRunner();
    runner.worktree = {
      create: vi.fn(),
      updateStatus: vi.fn(),
      cleanup: vi.fn(),
    };

    await expect(runner.run({ ...RUN_OPTS, ext: ['init-fail'] })).rejects.toThrow('init broken');

    expect(runner.worktree.create).not.toHaveBeenCalled();
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'mode::hitl');
  });

  it('passes projectName from RunnerOptions into InitContext', async () => {
    let captured: any = null;
    const { defineModule } = await import('../src/lib/modules/_registry');
    defineModule(() => ({
      name: 'capture-init',
      async onInit(ctx: any) { captured = ctx; },
    }));

    const { runner } = makeRunner();
    runner.worktree = {
      create: vi.fn(async () => { throw new Error('stop'); }),
      updateStatus: vi.fn(),
      cleanup: vi.fn(),
    };

    await expect(runner.run({
      ...RUN_OPTS,
      projectName: 'easyhaloo/faker_agent',
      ext: ['capture-init'],
    })).rejects.toThrow();

    expect(captured).toMatchObject({
      iid: 42,
      projectName: 'easyhaloo/faker_agent',
      baseBranch: 'main',
    });
    expect(typeof captured.originalCwd).toBe('string');
    expect(captured.originalCwd.length).toBeGreaterThan(0);
  });
});
