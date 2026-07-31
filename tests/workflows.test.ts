/**
 * Regression tests for WorkflowRunner.run() cleanup control flow.
 *
 * Covers two bugs introduced by the _cleanupType refactor:
 *  #1 hard-timeout path skipped cleanupOnFailure entirely (GitHub issue never
 *     updated on timeout) because handleTimeout set _cleanupType='timeout'.
 *  #2 `finally { if (...) return; }` overrode run()'s try-return, so run()
 *     returned undefined on timeout/handoff and crashed callers reading
 *     result.success.
 *
 * Strategy: stub runBody to drive the real handleTimeout (timeout case) or set
 * _cleanupType='success' (handoff case), then exercise the real run() finally
 * + cleanupOnFailure. tracker is injected; tmux/worktree are overwritten via
 * the instance. No module mocking.
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
  };
  runner.logDir = LOG_DIR;
  return { runner, tracker };
}

const RUN_OPTS = { iid: 42, session: 'sess', targetBranch: 'main', baseBranch: 'main' };

describe('WorkflowRunner.run() cleanup control flow', () => {
  afterEach(async () => {
    await rm(LOG_DIR, { recursive: true, force: true });
  });

  it('timeout path: posts timeout comment + mode::hitl and returns {success:false} (not undefined)', async () => {
    const { runner, tracker } = makeRunner();
    // Stub runBody to invoke the REAL handleTimeout (records _lastTimeoutInfo,
    // returns {success:false}). After the fix it must NOT set _cleanupType.
    runner.runBody = async function () {
      return await this.handleTimeout(42, '/tmp/wt', 'sess', 60000);
    };

    const result = await runner.run(RUN_OPTS);

    // #2: run() must return the try value, not undefined (no `return;` in finally).
    expect(result).toEqual({ success: false });
    // #1: cleanupOnFailure ran the timeout branch and updated the GitHub issue.
    expect(tracker.addComment).toHaveBeenCalledWith(42, expect.stringContaining('afk-event: timeout'));
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'mode::hitl');
    expect(tracker.removeLabel).toHaveBeenCalledWith(42, 'stage::afk-in-progress');
  });

  it('handoff path: skips cleanupOnFailure and returns {success:false} (not undefined)', async () => {
    const { runner, tracker } = makeRunner();
    // Simulate handleHandoff: it self-cleans (comment + label + killSession)
    // then sets _cleanupType='success' so finally skips cleanupOnFailure.
    runner.runBody = async function () {
      this._cleanupType = 'success';
      return { success: false };
    };

    const result = await runner.run(RUN_OPTS);

    // #2: run() must return {success:false}, not undefined.
    expect(result).toEqual({ success: false });
    // Handoff already cleaned up -> cleanupOnFailure must NOT run.
    expect(tracker.addComment).not.toHaveBeenCalled();
  });
});
