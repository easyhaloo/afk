/**
 * Regression tests for WorkflowRunner.run() cleanup control flow.
 *
 * Covers the _cleanupType state machine and finally-block cleanup:
 *  - timeout path: posts timeout comment + mode::hitl, returns {success:false}.
 *  - handoff path: handler self-cleans; finally skips cleanupOnFailure.
 *  - success path: removes the worktree (force), returns {success:true, url}.
 *  - below-threshold context_high (context_low): silent - no comment, no mode::hitl;
 *    worktree kept and marked 'failed'.
 *
 * Strategy: stub runBody to drive each path, then exercise the real run() finally
 * + cleanupOnFailure. tracker is injected; tmux/worktree are overwritten via the
 * instance. No module mocking.
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

describe('WorkflowRunner.run() cleanup control flow', () => {
  afterEach(async () => {
    await rm(LOG_DIR, { recursive: true, force: true });
  });

  it('timeout path: posts timeout comment + mode::hitl and returns {success:false}', async () => {
    const { runner, tracker } = makeRunner();
    runner.runBody = async function () {
      return await this.handleTimeout(42, '/tmp/wt', 'sess', 60000);
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

  it('handoff path: skips cleanupOnFailure and returns {success:false}', async () => {
    const { runner, tracker } = makeRunner();
    runner.runBody = async function () {
      this._cleanupType = 'success';
      return { success: false };
    };

    const result = await runner.run(RUN_OPTS);

    expect(result).toEqual({ success: false });
    expect(tracker.addComment).not.toHaveBeenCalled();
  });

  it('success path: removes worktree (force) and returns {success:true, url}', async () => {
    const { runner, tracker } = makeRunner();
    runner.runBody = async function () {
      return { success: true, url: 'https://example.com/mr/1' };
    };

    const result = await runner.run(RUN_OPTS);

    expect(result).toEqual({ success: true, url: 'https://example.com/mr/1' });
    expect(runner.worktree.cleanup).toHaveBeenCalledWith(42, true);
    expect(tracker.addComment).not.toHaveBeenCalled();
  });

  it('below-threshold context_high: silent (no comment, no mode::hitl), marks worktree failed', async () => {
    const { runner, tracker } = makeRunner();
    runner.runBody = async function () {
      this._cleanupType = 'context_low';
      return { success: false };
    };

    const result = await runner.run(RUN_OPTS);

    expect(result).toEqual({ success: false });
    expect(tracker.addComment).not.toHaveBeenCalled();
    expect(tracker.addLabel).not.toHaveBeenCalled();
    expect(runner.worktree.updateStatus).toHaveBeenCalledWith(42, 'failed');
    expect(runner.worktree.cleanup).not.toHaveBeenCalled();
  });
});
