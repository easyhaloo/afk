import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { HandoffCoordinator } from './handoff';
import type { BacklogProvider } from '../../domain/backlog/index';
import type { TmuxClient } from '../../infrastructure/tmux/tmux';
import type { Watchdog } from './watchdog';
import type { WorkflowConfig } from '../../infrastructure/config/manager';

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
  return { arm: vi.fn(), disarm: vi.fn(), isArmed: vi.fn(() => false) } as unknown as Watchdog;
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

function makeBacklog() {
  return {
    transition: vi.fn(async () => {}),
    setExecutionMode: vi.fn(async () => {}),
  } as unknown as BacklogProvider;
}

describe('HandoffCoordinator', () => {
  let wtPath: string;

  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-handoff-test-'));
  });

  afterEach(() => {
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  const ctx = (over: Partial<{ backlogId: string; gen: number; tokens: number; hardTimeoutMs: number }> = {}) => ({
    backlogId: '42',
    session: 'afk-backlog-42',
    wtPath,
    hardTimeoutMs: 60_000,
    gen: 1,
    tokens: 120_000,
    ...over,
  });

  // ── auto ───────────────────────────────────────────────────────────────────

  it('auto success: writes doc, posts comment, restarts session, re-arms watchdog', async () => {
    const backlog = makeBacklog();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 'implemented AC 1-3' })),
      capturePane: vi.fn(async () => 'line1\nline2'),
      waitForPrompt: vi.fn(async () => true),
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(backlog, tmux, watchdog, makeConfig());

    const outcome = await coord.handoff(ctx(), 'auto');

    expect(outcome).toBe('continued');
    // Disarm before negotiation, re-arm after relaunch.
    expect(watchdog.disarm).toHaveBeenCalledTimes(1);
    expect(watchdog.arm).toHaveBeenCalledWith('afk-backlog-42', 60_000, 42, wtPath);
    // Session torn down and recreated.
    expect(tmux.killSession).toHaveBeenCalledWith('afk-backlog-42');
    expect(tmux.createSession).toHaveBeenCalledWith('afk-backlog-42', wtPath);
    // Recovery doc on disk, travels with the worktree.
    const doc = fs.readFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'), 'utf-8');
    expect(doc).toContain('implemented AC 1-3');
    expect(doc).toContain('line1');
  });

  it('auto relaunch failure: flips to manual (handoff::active + killed), returns terminated', async () => {
    const backlog = makeBacklog();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 'partial work' })),
      waitForPrompt: vi.fn(async () => false), // relaunch: claude never ready
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(backlog, tmux, watchdog, makeConfig());

    const outcome = await coord.handoff(ctx(), 'auto');

    expect(outcome).toBe('terminated');
    expect(backlog.transition).toHaveBeenCalledWith('42', 'blocked', { reason: 'handoff relaunch failed' });
    expect(backlog.setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
    expect(tmux.killSession).toHaveBeenCalledWith('afk-backlog-42');
    // No re-arm: the session is dead, manual resume takes over.
    expect(watchdog.arm).not.toHaveBeenCalled();
  });

  it('auto no-summary (placeholder "<总结>"): doc falls back to snapshot, no summary', async () => {
    const backlog = makeBacklog();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: '<总结>' })),
      capturePane: vi.fn(async () => 'snapshot-line'),
      waitForPrompt: vi.fn(async () => true),
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(backlog, tmux, watchdog, makeConfig());

    await coord.handoff(ctx(), 'auto');

    const doc = fs.readFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-1.md'), 'utf-8');
    expect(doc).toContain('(agent did not provide a summary)');
    expect(doc).toContain('snapshot-line');
  });

  // ── terminal ───────────────────────────────────────────────────────────────

  it('terminal/budget: embeds terminal doc in comment, labels handoff::active, no re-arm', async () => {
    const backlog = makeBacklog();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 'final summary' })),
      capturePane: vi.fn(async () => 'final-snapshot'),
    });
    const watchdog = makeWatchdog();
    const coord = new HandoffCoordinator(backlog, tmux, watchdog, makeConfig());

    const outcome = await coord.handoff(ctx({ gen: 2 }), 'terminal', 'budget');

    expect(outcome).toBe('terminated');
    expect(watchdog.disarm).toHaveBeenCalledTimes(1);
    expect(watchdog.arm).not.toHaveBeenCalled();
    expect(backlog.transition).toHaveBeenCalledWith('42', 'blocked', { reason: 'budget' });
    expect(backlog.setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
    // Terminal doc on disk with the 'terminal' generation marker.
    const doc = fs.readFileSync(path.join(wtPath, '.afk', 'handoff', 'handoff-42-terminal.md'), 'utf-8');
    expect(doc).toContain('round terminal');
    // Session killed, not restarted.
    expect(tmux.killSession).toHaveBeenCalledWith('afk-backlog-42');
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it('terminal/tokens: surfaces the token-budget reason text', async () => {
    const backlog = makeBacklog();
    const tmux = makeTmux({
      waitForSignal: vi.fn(async () => ({ type: 'handoff_ready', summary: 's' })),
      capturePane: vi.fn(async () => 'snap'),
    });
    const coord = new HandoffCoordinator(backlog, tmux, makeWatchdog(), makeConfig());

    await coord.handoff(ctx(), 'terminal', 'tokens');

    expect(backlog.transition).toHaveBeenCalledWith('42', 'blocked', { reason: 'tokens' });
  });
});
