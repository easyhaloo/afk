import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { WorkflowRunner } from './workflows';
import { writeSignal } from './io';
import type { TrackerProvider } from './core/tracker/types';
import type { TmuxClient } from './core/tmux/tmux';
import type { HandoffCoordinator } from './workflows/handoff';
import type { Sandbox, AgentExecution, AgentStartOptions, ExecutionResult, InterruptReason, CaptureOptions } from './sandbox/types';
import type { ResumeOptions, SessionSnapshot } from './agents/types';

/** Minimal fake tmux: sendGoal is a noop so runPhase never blocks on a real session. */
function makeTmux(): TmuxClient {
  return {
    sendGoal: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    capturePane: vi.fn(async () => 'fake pane snapshot'),
  } as unknown as TmuxClient;
}

function makeTracker(): TrackerProvider {
  return {
    platform: 'github',
    projectId: 'test/repo',
    addComment: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
  } as unknown as TrackerProvider;
}

/**
 * Stateful fake execution for runPhase routing tests.
 * Returns results in the order given; each `waitForResult()` consumes the next one.
 * This replaces the legacy signal-poll path so tests don't depend on timing.
 */
function makeFakeExecution(results: ExecutionResult[]): AgentExecution {
  let i = 0;
  return {
    id: 'fake-exec',
    sessionId: 'afk-gh-42',
    async waitForEvent() { return null; },
    async waitForResult() {
      const r = results[i++] ?? results[results.length - 1];
      return r;
    },
    async interrupt(_reason: InterruptReason) {},
    async kill() {},
    async captureOutput(_options?: CaptureOptions) { return ''; },
    async captureSession(): Promise<SessionSnapshot | undefined> { return undefined; },
    async resume(_options: ResumeOptions): Promise<AgentExecution> { throw new Error('not supported'); },
  };
}

function makeFakeSandbox(exec: AgentExecution): Sandbox {
  return {
    id: 'fake-sandbox',
    worktreePath: '',
    workspacePath: '',
    async startAgent(_options: AgentStartOptions) { return exec; },
    async close() {},
  };
}

/** Write a high-token status file so waitForPhaseSignal sees context_high. */
function writeHighTokens(wtPath: string, inputTokens = 150_000): void {
  fs.mkdirSync(path.join(wtPath, '.afk'), { recursive: true });
  fs.writeFileSync(
    path.join(wtPath, '.afk', 'claude-status.json'),
    JSON.stringify({
      context_window: {
        context_window_size: 200_000,
        current_usage: { input_tokens: inputTokens },
      },
    }),
  );
}

const ISO = '2026-08-02T00:00:00.000Z';

describe('WorkflowRunner.runPhase routing', () => {
  let wtPath: string;

  beforeEach(() => {
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-runner-test-'));
  });

  afterEach(() => {
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  /** Build a runner whose coordinator is the given fake, with a noop tmux. */
  function runnerWith(fakeCoord: { handoff: ReturnType<typeof vi.fn> }): WorkflowRunner {
    const runner = new WorkflowRunner(makeTracker(), {
      tmux: makeTmux(),
      coordinatorFactory: () => fakeCoord as unknown as HandoffCoordinator,
    });
    // Tighten the poll so the first tick lands immediately.
    (runner as unknown as { pollIntervalMs: number }).pollIntervalMs = 5;
    return runner;
  }

  /** runPhase is private; call it directly to test routing in isolation. */
  function runPhase(runner: WorkflowRunner, over: Record<string, unknown> = {}) {
    return (runner as unknown as {
      runPhase: (p: Record<string, unknown>) => Promise<boolean>;
    }).runPhase({
      iid: 42,
      session: 'afk-gh-42',
      wtPath,
      hardTimeoutMs: 60_000,
      completionTimeoutMs: 5_000,
      contextHighTokens: 100_000,
      budget: { used: 0, tokens: 0 },
      maxHandoffs: 3,
      maxTotalTokens: 500_000,
      goalBase: '实现 issue #42',
      signalType: 'goal_complete',
      ...over,
    });
  }

  // ── issue #42 regression ───────────────────────────────────────────────────
  it('detects a goal_complete signal and completes the phase (issue #42 regression)', async () => {
    // The agent wrote goal_complete before the runner polled - it must NOT be
    // lost (the bug: signal written but not handled).
    await writeSignal({ type: 'goal_complete', timestamp: ISO, summary: 'done' }, wtPath);

    const coord = { handoff: vi.fn(async () => 'terminated') };
    const runner = runnerWith(coord);
    // Inject a fake sandbox that returns `completed` on first waitForResult()
    // — exercises the same routing the real signal-poll path would, without
    // timing flake from LegacyExecutionWrapper.
    runner.setSandbox(makeFakeSandbox(makeFakeExecution([
      { version: 1, runId: 'r1', status: 'completed', provider: 'local', commits: [] },
    ])));

    const completed = await runPhase(runner);

    expect(completed).toBe(true);
    expect(coord.handoff).not.toHaveBeenCalled();
  });

  // ── budget exhaustion -> terminal ──────────────────────────────────────────
  it('routes to a terminal handoff when the round budget is exhausted', async () => {
    writeHighTokens(wtPath); // context_high, no completion signal -> handoff outcome
    const coord = { handoff: vi.fn(async () => 'terminated') };
    const runner = runnerWith(coord);

    const completed = await runPhase(runner, { budget: { used: 3, tokens: 0 } }); // used >= maxHandoffs

    expect(completed).toBe(false);
    expect(coord.handoff).toHaveBeenCalledTimes(1);
    const [hctx, mode, reason] = coord.handoff.mock.calls[0];
    expect(mode).toBe('terminal');
    expect(reason).toBe('budget');
    expect(hctx).toMatchObject({ iid: 42, session: 'afk-gh-42', wtPath });
  });

  it('routes to a terminal handoff when the total-token budget is exhausted', async () => {
    writeHighTokens(wtPath);
    const coord = { handoff: vi.fn(async () => 'terminated') };
    const runner = runnerWith(coord);

    // used(1) < maxHandoffs(3), but tokens(400k) + outcome(150k) >= maxTotalTokens(500k).
    const completed = await runPhase(runner, {
      budget: { used: 1, tokens: 400_000 },
    });

    expect(completed).toBe(false);
    const [hctx, mode, reason] = coord.handoff.mock.calls[0];
    expect(mode).toBe('terminal');
    expect(reason).toBe('tokens');
  });

  // ── auto-handoff success -> loop continues ─────────────────────────────────
  it('continues the loop after a successful auto-handoff (budget increments)', async () => {
    writeHighTokens(wtPath); // round 1: context_high -> handoff
    const coord = {
      handoff: vi.fn(async (ctx: { wtPath: string }, mode: string) => {
        if (mode === 'auto') {
          // Simulate a successful relaunch: clear the token data, then the
          // resumed session completes and writes goal_complete.
          fs.rmSync(path.join(ctx.wtPath, '.afk', 'claude-status.json'), { force: true });
          await writeSignal({ type: 'goal_complete', timestamp: ISO, summary: 'resumed done' }, ctx.wtPath);
          return 'continued';
        }
        return 'terminated';
      }),
    };
    const runner = runnerWith(coord);
    // round 1: context_high; round 2: completed (coordinator clears tokens + writes signal).
    runner.setSandbox(makeFakeSandbox(makeFakeExecution([
      { version: 1, runId: 'r1', status: 'context_high', provider: 'local', usage: { inputTokens: 150_000, outputTokens: 0, totalTokens: 150_000 }, commits: [] },
      { version: 1, runId: 'r2', status: 'completed', provider: 'local', commits: [] },
    ])));

    const completed = await runPhase(runner);

    expect(completed).toBe(true);
    // Exactly one auto-handoff on round 1 (gen=1); round 2 detected the signal.
    expect(coord.handoff).toHaveBeenCalledTimes(1);
    const [hctx, mode] = coord.handoff.mock.calls[0];
    expect(mode).toBe('auto');
    expect(hctx).toMatchObject({ iid: 42, gen: 1, tokens: 150_000 });
  });
});
