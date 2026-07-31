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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rm } from 'fs/promises';
import { WorkflowRunner } from '../src/lib/workflows';

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
