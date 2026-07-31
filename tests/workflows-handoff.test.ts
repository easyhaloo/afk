/**
 * Regression tests for WorkflowRunner auto-continue after context handoff.
 *
 * Runs the REAL runBody with mocked tmux/worktree/autoWrapup/startWatchdog
 * and real io functions against real temp dirs: signal files and statusline
 * token payloads are written to disk, and waitForPhaseSignal's polling
 * (pollIntervalMs=10) picks them up like a real run would.
 *
 * Cases:
 *  - auto-relaunch happy path (context_high → handoff → continue → success)
 *  - configurable contextHighTokens threshold
 *  - handoff budget exhaustion → terminal handoff (manual resume)
 *  - stale signal cleared on relaunch; placeholder summary falls back to snapshot
 *  - relaunch failure → flips to manual handoff (handoff::active, no crash path)
 *  - killWatchdog kills the detached watchdog process group
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { promises as fs, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorkflowRunner } from '../src/lib/workflows';

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'afk-handoff-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSignal(wtPath: string, type: string, extra: Record<string, unknown> = {}): Promise<void> {
  // goal_complete/handoff_ready require a non-empty summary in the zod schema.
  await fs.writeFile(
    join(wtPath, '.afk-signal.json'),
    JSON.stringify({ type, timestamp: new Date().toISOString(), summary: 'test summary', ...extra }),
    'utf-8',
  );
}

async function writeStatus(wtPath: string, totalTokens: number): Promise<void> {
  await fs.mkdir(join(wtPath, '.afk'), { recursive: true });
  await fs.writeFile(
    join(wtPath, '.afk', 'claude-status.json'),
    JSON.stringify({
      context_window: {
        context_window_size: 200000,
        current_usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    'utf-8',
  );
}

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

const handoffReady = (summary: string) => ({
  type: 'handoff_ready',
  timestamp: new Date().toISOString(),
  summary,
});

function makeRunner(wtPath: string) {
  const tracker = {
    addComment: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  } as any;

  const runner = new WorkflowRunner(tracker) as any;
  const logDir = join(tmpdir(), `afk-handoff-logs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDirs.push(logDir);
  runner.logDir = logDir;
  runner.pollIntervalMs = 10;
  runner.tmux = {
    createSession: vi.fn().mockResolvedValue({ name: 'sess', window: 'main', dir: wtPath }),
    waitForPrompt: vi.fn().mockResolvedValue(true),
    sendGoal: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    waitForSignal: vi.fn().mockResolvedValue(null),
    capturePane: vi.fn().mockResolvedValue('pane snapshot'),
    killSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
  };
  runner.worktree = {
    create: vi.fn().mockResolvedValue({ path: wtPath, branch: 'afk-issue-42', status: 'active' }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  runner.autoWrapup = vi.fn().mockResolvedValue({ success: true, url: 'https://example.com/mr/1' });
  runner.startWatchdog = vi.fn();
  return { runner, tracker, tmux: runner.tmux };
}

const RUN_OPTS = { iid: 42, session: 'sess', targetBranch: 'main', baseBranch: 'main' };

describe('WorkflowRunner auto handoff continuation', () => {
  it('auto-relaunch: context_high → handoff → continue → success', async () => {
    const wtPath = makeTempDir();
    const { runner, tracker, tmux } = makeRunner(wtPath);
    await writeStatus(wtPath, 120_000); // ≥ default 100k → polling detection
    tmux.waitForSignal.mockResolvedValue(handoffReady('已完成实现核心逻辑，正在进行测试'));

    const runPromise = runner.run(RUN_OPTS);

    // Wait for the auto-relaunch, then drive the phases via real signal files.
    await waitFor(() => tmux.createSession.mock.calls.length === 2);
    await writeSignal(wtPath, 'goal_complete');
    await waitFor(() => tmux.sendGoal.mock.calls.length === 3); // phase 2 started
    await writeSignal(wtPath, 'ac_result');

    const result = await runPromise;

    expect(result).toEqual({ success: true, url: 'https://example.com/mr/1' });
    expect(tmux.sendGoal).toHaveBeenCalledTimes(3);
    const continueGoal = String(tmux.sendGoal.mock.calls[1][3]);
    expect(continueGoal).toContain('继续实现');
    expect(continueGoal).toContain('handoff-42-1.md');
    expect(tmux.createSession).toHaveBeenCalledTimes(2);
    expect(runner.startWatchdog).toHaveBeenCalledTimes(2); // initial + per-generation re-arm

    const typed = tmux.sendKeys.mock.calls.map((c: unknown[]) => String(c[2])).join('\n');
    expect(typed).toContain('git add -A && git commit');

    const doc = await fs.readFile(join(runner.logDir, 'handoff-42-1.md'), 'utf-8');
    expect(doc).toContain('已完成实现核心逻辑，正在进行测试');
    expect(tracker.addComment).toHaveBeenCalledWith(42, expect.stringContaining('已完成实现核心逻辑，正在进行测试'));
    expect(tracker.addLabel).not.toHaveBeenCalledWith(42, 'handoff::active'); // auto mode: no manual-resume marker
  });

  it('configurable contextHighTokens triggers earlier than the default', async () => {
    const wtPath = makeTempDir();
    const { runner, tmux } = makeRunner(wtPath);
    await writeStatus(wtPath, 60_000); // below default 100k, above configured 50k
    tmux.waitForSignal.mockResolvedValue(handoffReady('s'));

    const runPromise = runner.run({ ...RUN_OPTS, contextHighTokens: 50_000 });
    await waitFor(() => tmux.createSession.mock.calls.length === 2);
    await writeSignal(wtPath, 'goal_complete');
    await waitFor(() => tmux.sendGoal.mock.calls.length === 3);
    await writeSignal(wtPath, 'ac_result');

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(String(tmux.sendGoal.mock.calls[1][3])).toContain('handoff-42-1.md');
  });

  it('budget exhaustion: falls back to terminal handoff (manual resume)', async () => {
    const wtPath = makeTempDir();
    const { runner, tracker, tmux } = makeRunner(wtPath);
    await writeStatus(wtPath, 120_000);
    tmux.waitForSignal.mockResolvedValue(handoffReady('s'));

    const runPromise = runner.run({ ...RUN_OPTS, maxHandoffs: 1 });
    await waitFor(() => tmux.createSession.mock.calls.length === 2); // one auto relaunch
    await writeStatus(wtPath, 120_000); // new session's context fills again

    const result = await runPromise;

    expect(result).toEqual({ success: false });
    expect(tmux.createSession).toHaveBeenCalledTimes(2); // no third relaunch
    await expect(fs.access(join(runner.logDir, 'handoff-42-1.md'))).resolves.toBeUndefined();
    await expect(fs.access(join(runner.logDir, 'handoff-42-terminal.md'))).resolves.toBeUndefined();
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'handoff::active');
    expect(tracker.addLabel).not.toHaveBeenCalledWith(42, 'mode::hitl'); // finally skipped via _cleanupType='success'
  });

  it('unrecognized signal file is ignored; only the token threshold triggers handoff', async () => {
    const wtPath = makeTempDir();
    const { runner, tracker, tmux } = makeRunner(wtPath);
    await writeStatus(wtPath, 50_000); // below threshold
    await writeSignal(wtPath, 'context_high'); // schema-unknown type: parsed as no signal, ignored

    const runPromise = runner.run(RUN_OPTS);
    await new Promise(r => setTimeout(r, 300)); // let a few polls happen
    await writeStatus(wtPath, 120_000); // objective threshold reached

    await waitFor(() => tmux.createSession.mock.calls.length === 2);
    await writeSignal(wtPath, 'goal_complete');
    await waitFor(() => tmux.sendGoal.mock.calls.length === 3);
    await writeSignal(wtPath, 'ac_result');

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(tracker.addLabel).not.toHaveBeenCalledWith(42, 'handoff::active');
  });

  it('stale signal cleared on relaunch; template placeholder summary falls back to snapshot', async () => {
    const wtPath = makeTempDir();
    const { runner, tmux } = makeRunner(wtPath);
    await writeStatus(wtPath, 120_000);
    await writeSignal(wtPath, 'handoff_ready'); // stale from a previous run's negotiation
    tmux.waitForSignal.mockResolvedValue(handoffReady('<总结>')); // agent copied the template verbatim

    const runPromise = runner.run(RUN_OPTS);

    await waitFor(() => tmux.createSession.mock.calls.length === 2);
    // The stale signal file must have been cleared before the relaunch.
    await expect(fs.access(join(wtPath, '.afk-signal.json'))).rejects.toThrow();
    await writeSignal(wtPath, 'goal_complete');
    await waitFor(() => tmux.sendGoal.mock.calls.length === 3);
    await writeSignal(wtPath, 'ac_result');

    const result = await runPromise;

    expect(result.success).toBe(true);
    const doc = await fs.readFile(join(runner.logDir, 'handoff-42-1.md'), 'utf-8');
    expect(doc).toContain('(agent did not provide a summary)'); // placeholder treated as no summary
    expect(doc).toContain('pane snapshot');
    expect(String(tmux.sendGoal.mock.calls[1][3])).toContain('handoff-42-1.md');
  });

  it('relaunch failure flips to manual handoff (no crash path)', async () => {
    const wtPath = makeTempDir();
    const { runner, tracker, tmux } = makeRunner(wtPath);
    await writeStatus(wtPath, 120_000);
    tmux.waitForSignal.mockResolvedValue(handoffReady('s'));
    tmux.waitForPrompt
      .mockResolvedValueOnce(true)   // initial launch (runBody step 2)
      .mockResolvedValueOnce(false); // relaunch

    const result = await runner.run(RUN_OPTS);

    expect(result).toEqual({ success: false });
    expect(tracker.addLabel).toHaveBeenCalledWith(42, 'handoff::active');
    expect(tracker.addLabel).not.toHaveBeenCalledWith(42, 'mode::hitl');
    await expect(fs.access(join(runner.logDir, 'handoff-42-1.md'))).resolves.toBeUndefined();
  });

  it('killWatchdog kills the detached watchdog process group', async () => {
    const { runner } = makeRunner(makeTempDir());
    const child = spawn('bash', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    child.unref();
    runner._watchdog = child;
    await new Promise(r => setTimeout(r, 300)); // let the process spawn
    runner.killWatchdog();
    await new Promise(r => setTimeout(r, 300)); // let SIGTERM take effect
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});
