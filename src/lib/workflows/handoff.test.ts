import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { HandoffCoordinator } from './handoff';
import type { TrackerProvider } from '../core/tracker/types';
import type { TmuxClient } from '../core/tmux/tmux';
import type { WatchdogAdapter } from './watchdog';
import type { WorkflowConfig } from '../core/config/manager';

/** Fake tmux: every method is a vi.fn with sane defaults, overridable per-test. */
function makeTmux(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    killSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ name: 'main', window: 'main', dir: '' })),
    waitForPrompt: vi.fn(async () => true),
    capturePane: vi.fn(async () => '(empty pane)'),
    waitForSignal: vi.fn(async () => null),
    sendKeys: vi.fn(async () => {}),
    ...overrides,
  } as unknown as TmuxClient;
}

function makeWatchdog() {
  return { arm: vi.fn(), disarm: vi.fn(), isArmed: vi.fn(() => false) } as unknown as WatchdogAdapter;
}

function makeConfig(): WorkflowConfig {
  return {
    agentDefault: 'claude',
    tmuxSession: 'afk',
    completionTimeout: 7200 * 1000,
    workflowHardTimeout: 7200 * 1000,
    completionPoll: 5,
    idleTimeout: 1800 * 1000,
    acCheckTimeout: 180 * 1000,
    contextThreshold: 100_000,
    promptTimeout: 30_000,
    handoffTimeout: 60_000,
    maxRetries: 2,
    targetBranch: 'main',
    trackerTargetBranch: 'main',
    goalBudget: 10_000_000,
  };
}

function makeTracker() {
  return {
    platform: 'github',
    projectId: 'test/repo',
    addComment: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    getIssue: vi.fn(async () => ({ id: 42, title: 'Issue 42', description: '' })),
  } as unknown as TrackerProvider;
}

describe('HandoffCoordinator', () => {
  let wtPath: string;

  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-handoff-test-'));
  });

  afterEach(() => {
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  const ctx = (over: Partial<{ iid: number; gen: number; tokens: number; hardTimeoutMs: number }> = {}) => ({
    iid: 42,
    session: 'afk-gh-42',
    wtPath,
    hardTimeoutMs: 60_000,
    gen: 1,
    tokens: 120_000,
    ...over,
  });

  // ── auto ───────────────────────────────────────────────────────────────────

  it('auto success: writes doc, posts comment, restarts session, re-arms watchdog', async () => {
    const tracker = makeTracker();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 'implemented AC 1-3' })),
      capturePane: vi.fn(async () => 'line1\nline2'),
      waitForPrompt: vi.fn(async () => true),
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(tracker, tmux, watchdog, makeConfig());

    const outcome = await coord.handoff(ctx(), 'auto');

    expect(outcome).toBe('continued');
    // Disarm before negotiation, re-arm after relaunch.
    expect(watchdog.disarm).toHaveBeenCalledTimes(1);
    expect(watchdog.arm).toHaveBeenCalledWith('afk-gh-42', 60_000, 42, wtPath);
    // Session torn down and recreated.
    expect(tmux.killSession).toHaveBeenCalledWith('afk-gh-42');
    expect(tmux.createSession).toHaveBeenCalledWith('afk-gh-42', wtPath);
    // In-progress comment posted with round + summary.
    expect(tracker.addComment).toHaveBeenCalledTimes(1);
    expect(tracker.addComment.mock.calls[0][0]).toBe(42);
    const comment = tracker.addComment.mock.calls[0][1];
    expect(comment).toContain('Round:** 1');
    expect(comment).toContain('implemented AC 1-3');
    expect(comment).toContain('context_high (~120000 tokens)');
    // Recovery doc on disk, travels with the worktree.
    const doc = fs.readFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'), 'utf-8');
    expect(doc).toContain('implemented AC 1-3');
    expect(doc).toContain('line1');
  });

  it('auto relaunch failure: flips to manual (handoff::active + killed), returns terminated', async () => {
    const tracker = makeTracker();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 'partial work' })),
      waitForPrompt: vi.fn(async () => false), // relaunch: claude never ready
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(tracker, tmux, watchdog, makeConfig());

    const outcome = await coord.handoff(ctx(), 'auto');

    expect(outcome).toBe('terminated');
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'handoff::active');
    expect(tmux.killSession).toHaveBeenCalledWith('afk-gh-42');
    // No re-arm: the session is dead, manual resume takes over.
    expect(watchdog.arm).not.toHaveBeenCalled();
  });

  it('auto no-summary (placeholder "<总结>"): doc falls back to snapshot, no summary', async () => {
    const tracker = makeTracker();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: '<总结>' })),
      capturePane: vi.fn(async () => 'snapshot-line'),
      waitForPrompt: vi.fn(async () => true),
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(tracker, tmux, watchdog, makeConfig());

    await coord.handoff(ctx(), 'auto');

    const doc = fs.readFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'), 'utf-8');
    expect(doc).toContain('(agent did not provide a summary)');
    expect(doc).toContain('snapshot-line');
    const comment = tracker.addComment.mock.calls[0][1];
    expect(comment).toContain('(agent did not provide a summary)');
  });

  // ── terminal ───────────────────────────────────────────────────────────────

  it('terminal/budget: embeds terminal doc in comment, labels handoff::active, no re-arm', async () => {
    const tracker = makeTracker();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 'final summary' })),
      capturePane: vi.fn(async () => 'final-snapshot'),
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(tracker, tmux, watchdog, makeConfig());

    const outcome = await coord.handoff(ctx({ gen: 2 }), 'terminal', 'budget');

    expect(outcome).toBe('terminated');
    expect(watchdog.disarm).toHaveBeenCalledTimes(1);
    expect(watchdog.arm).not.toHaveBeenCalled();
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'handoff::active');
    // Terminal comment embeds the doc content + resume instruction.
    const comment = tracker.addComment.mock.calls[0][1];
    expect(comment).toContain('已达最大交接轮数');
    expect(comment).toContain('To resume');
    expect(comment).toContain('final summary');
    // Terminal doc on disk with the 'terminal' generation marker.
    const doc = fs.readFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-terminal.md'), 'utf-8');
    expect(doc).toContain('round terminal');
    // Session killed, not restarted.
    expect(tmux.killSession).toHaveBeenCalledWith('afk-gh-42');
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it('terminal/tokens: surfaces the token-budget reason text', async () => {
    const tracker = makeTracker();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 's' })),
      capturePane: vi.fn(async () => 'snap'),
    });
    const coord = new HandoffCoordinator(tracker, tmux, makeWatchdog(), makeConfig());

    await coord.handoff(ctx(), 'terminal', 'tokens');

    const comment = tracker.addComment.mock.calls[0][1];
    expect(comment).toContain('已达总 token 上限');
  });
});
