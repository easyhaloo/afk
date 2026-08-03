import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { LoopRunner } from './modules/loop-runner';
import type { TrackerProvider, TrackedIssue } from './core/tracker/types';
import type { WorkflowRunner } from './workflows';
import type { QARunner } from './qa-runner';

const REQ = ['mode::afk', 'stage::ready-for-issues'];
const EXC = ['stage::afk-in-progress', 'stage::qa', 'stage::done', 'mode::hitl'];

/** Build fresh tmp paths per call so concurrent test files don't collide. */
function tmpPaths() {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `afk-loop-test-${stamp}-`));
  return {
    pidFilePath: path.join(dir, 'loop.pid'),
    statusFilePath: path.join(dir, 'loop-status.json'),
  };
}

function makeTracker(issues: TrackedIssue[]): any {
  const byId = new Map<number, TrackedIssue>(issues.map(i => [i.id, i]));

  return {
    platform: 'github',
    projectId: 'test/repo',
    getIssue: vi.fn(async (id: number) => byId.get(id) ?? {
      id, platform: 'github', title: `Issue ${id}`, description: '',
      labels: ['mode::afk', 'stage::ready-for-issues', 'base::prd-1'],
      state: 'opened', url: '', projectId: 'test/repo',
    }),
    listIssues: vi.fn(async (opts?: { labels?: string[]; state?: string }) => {
      // Filter by labels if provided — important for preconditions' blocker check
      if (opts?.labels && opts.labels.length > 0) {
        return issues.filter(i => opts.labels!.every(l => i.labels.includes(l)));
      }
      return issues;
    }),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    addLabel: vi.fn(async (id: number, label: string) => {
      const issue = byId.get(id);
      if (issue && !issue.labels.includes(label)) issue.labels.push(label);
    }),
    removeLabel: vi.fn(async (id: number, label: string) => {
      const issue = byId.get(id);
      if (issue) issue.labels = issue.labels.filter((l: string) => l !== label);
    }),
    addComment: vi.fn(),
    linkIssues: vi.fn(),
    getMR: vi.fn(),
    listMRs: vi.fn(async () => []),
    createMR: vi.fn(),
    mergeMR: vi.fn(),
    approveMR: vi.fn(),
    closeMR: vi.fn(),
    reopenMR: vi.fn(),
    listProjects: vi.fn(async () => []),
    getBranches: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getRecentCommits: vi.fn(async () => []),
    parseAC: vi.fn(() => ({ items: [{ id: '1', text: 'AC 1', done: false }], source: 'labels' })),
    getRetryCount: vi.fn(() => 0),
    detectTargetBranch: vi.fn(async () => 'main'),
    uploadArtifacts: vi.fn(async () => ''),
  };
}

function makeIssue(id: number, extraLabels?: string[]): TrackedIssue {
  return {
    id,
    platform: 'github',
    title: `Issue ${id}`,
    description: '',
    labels: ['mode::afk', 'stage::ready-for-issues', 'base::prd-1', ...(extraLabels ?? [])],
    state: 'opened',
    url: '',
    projectId: 'test/repo',
  };
}

describe('LoopRunner', () => {
  let tracker: any;
  let workflowRunImpl: any;
  let qaProcessImpl: any;

  beforeEach(() => {
    workflowRunImpl = vi.fn();
    qaProcessImpl = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks up a ready issue and runs WorkflowRunner', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: true, url: 'https://mr/24' });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length > 0, 2_000);
    expect(workflowRunImpl).toHaveBeenCalledTimes(1);
    expect(workflowRunImpl.mock.calls[0][0].iid).toBe(24);
    expect(workflowRunImpl.mock.calls[0][0].session).toBe('afk-gh-24');

    await runner.stop();
    await runPromise;
  });

  it('moves successful implement into qaQueue, then runs QARunner', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: true });
    qaProcessImpl.mockResolvedValue({ success: true, mrUrl: 'https://mr/24' });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => qaProcessImpl.mock.calls.length > 0, 2_000);
    expect(qaProcessImpl).toHaveBeenCalledWith(24);

    await waitFor(() => runner.getStatus().totals.completed === 1, 2_000);
    const s = runner.getStatus();
    expect(s.totals.completed).toBe(1);
    expect(s.totals.failed).toBe(0);
    expect(s.qa.active).toBeNull();

    await runner.stop();
    await runPromise;
  });

  it('counts implement failure without crashing the loop', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => runner.getStatus().totals.failed === 1, 2_000);
    expect(workflowRunImpl).toHaveBeenCalledTimes(1);
    expect(qaProcessImpl).not.toHaveBeenCalled();

    await runner.stop();
    await runPromise;
  });

  it('survives an unexpected throw from WorkflowRunner', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockRejectedValue(new Error('boom'));

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => runner.getStatus().totals.failed === 1, 2_000);
    expect(tracker.addLabel).toHaveBeenCalledWith(24, 'mode::hitl');

    await runner.stop();
    await runPromise;
  });

  it('stop() resolves via the timeout branch when a chain never finishes', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    // Chain that never settles — drain can never complete.
    workflowRunImpl.mockImplementation(() => new Promise(() => {}));

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 100,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length > 0, 2_000);

    const started = Date.now();
    await runner.stop();
    const elapsed = Date.now() - started;

    // Resolved via the timeout branch (nothing drained), not immediately.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(runner.getStatus().implement.ids).toContain(24);
    await runPromise;
  });

  it('counts QA failure', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: true });
    qaProcessImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => runner.getStatus().totals.failed === 1, 2_000);
    expect(qaProcessImpl).toHaveBeenCalledWith(24);
    expect(runner.getStatus().totals.completed).toBe(0);

    await runner.stop();
    await runPromise;
  });

  it('survives an unexpected throw from QARunner and adds mode::hitl best-effort', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: true });
    qaProcessImpl.mockRejectedValue(new Error('qa boom'));

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => runner.getStatus().totals.failed === 1, 2_000);
    expect(tracker.addLabel).toHaveBeenCalledWith(24, 'mode::hitl');

    await runner.stop();
    await runPromise;
  });

  it('respects maxConcurrent: only N implement chains run in parallel', async () => {
    const issues = [24, 25, 26, 27].map(id => makeIssue(id));
    tracker = makeTracker(issues);

    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    workflowRunImpl.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return { success: false };
    });
    qaProcessImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 2,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 5_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length >= 2, 2_000);
    await new Promise(r => setTimeout(r, 100));
    expect(maxActive).toBeLessThanOrEqual(2);

    releases.splice(0).forEach(r => r());
    await waitFor(() => workflowRunImpl.mock.calls.length === 4, 3_000);
    expect(workflowRunImpl).toHaveBeenCalledTimes(4);

    await runner.stop();
    await runPromise;
  });

  it('processes QA serially even when multiple chains finish at once', async () => {
    const issues = [24, 25].map(id => makeIssue(id));
    tracker = makeTracker(issues);
    workflowRunImpl.mockResolvedValue({ success: true });

    let qaActive = 0;
    let maxQA = 0;
    const qaReleases: Array<() => void> = [];
    qaProcessImpl.mockImplementation(async () => {
      qaActive++;
      maxQA = Math.max(maxQA, qaActive);
      await new Promise<void>(resolve => qaReleases.push(resolve));
      qaActive--;
      return { success: true, mrUrl: 'https://mr/x' };
    });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 5,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 5_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => qaProcessImpl.mock.calls.length >= 1, 2_000);
    await new Promise(r => setTimeout(r, 100));
    expect(maxQA).toBeLessThanOrEqual(1);

    qaReleases.splice(0).forEach(r => r());
    await waitFor(() => qaProcessImpl.mock.calls.length === 2, 2_000);
    expect(qaProcessImpl).toHaveBeenCalledTimes(2);
    qaReleases.splice(0).forEach(r => r());

    await runner.stop();
    await runPromise;
  });

  it('skips issues already in an exclude-label state on poll', async () => {
    const ready = makeIssue(24);
    const inProgress = makeIssue(25, ['stage::afk-in-progress']);
    const inQA = makeIssue(26, ['stage::qa']);
    const done = makeIssue(27, ['stage::done']);
    tracker = makeTracker([ready, inProgress, inQA, done]);

    workflowRunImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 3,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length >= 1, 2_000);
    await new Promise(r => setTimeout(r, 100));
    const calledIids = workflowRunImpl.mock.calls.map((c: any) => c[0].iid);
    // Exclude-labelled issues must never run. Issue 24 is the only ready one,
    // and may run repeatedly: an implement failure releases its inFlight
    // reservation so it can be picked up again by the next poll.
    expect(new Set(calledIids)).toEqual(new Set([24]));

    await runner.stop();
    await runPromise;
  });

  it('stops after maxIterations successful completions', async () => {
    const issues = [24, 25].map(id => makeIssue(id));
    tracker = makeTracker(issues);
    workflowRunImpl.mockResolvedValue({ success: true });
    qaProcessImpl.mockResolvedValue({ success: true, mrUrl: 'https://mr/x' });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 2,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 5_000,
      maxIterations: 2,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    await Promise.race([
      runner.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('start did not resolve in time')), 5_000)),
    ]);
    expect(runner.getStatus().totals.completed).toBe(2);
  });

  it('writes pid file on start and deletes it on stop', async () => {
    const paths = tmpPaths();
    tracker = makeTracker([]);

    const runner = new LoopRunner(tracker, {
      ...paths,
      maxConcurrent: 1,
      pollIntervalMs: 10_000,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    // Before start: pid file does not exist
    expect(fs.existsSync(paths.pidFilePath)).toBe(false);

    const runPromise = runner.start();
    await waitFor(() => fs.existsSync(paths.pidFilePath), 1_000);

    // After start: pid file contains our pid
    const written = fs.readFileSync(paths.pidFilePath, 'utf-8').trim();
    expect(written).toBe(String(process.pid));

    // After stop: pid file is gone
    await runner.stop();
    await runPromise;
    expect(fs.existsSync(paths.pidFilePath)).toBe(false);
  });

  it('writes status JSON file when printStatus fires', async () => {
    const paths = tmpPaths();
    tracker = makeTracker([]);

    // Make printStatus fire on every pollTick cycle — set a tiny statusInterval
    const runner = new LoopRunner(tracker, {
      ...paths,
      maxConcurrent: 1,
      pollIntervalMs: 10_000,
      statusIntervalMs: 50, // very short so the timer fires quickly
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => fs.existsSync(paths.statusFilePath), 2_000);
    const raw = fs.readFileSync(paths.statusFilePath, 'utf-8');
    const status = JSON.parse(raw);
    expect(status.pid).toBe(process.pid);
    expect(status.implement.active).toBe(0);
    expect(status.totals.completed).toBe(0);
    expect(typeof status.startedAt).toBe('number');
    expect(typeof status.lastUpdateAt).toBe('number');

    await runner.stop();
    await runPromise;
  });

  // ── resolveModules tests ──────────────────────────────────────────────────

  it('resolveModules: no moduleTriggers passes base ext', async () => {
    const issue = makeIssue(24);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 1,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      ext: ['isolate'],
      // No moduleTriggers → should pass via `ext: ['isolate']`
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length > 0, 2_000);
    expect(workflowRunImpl.mock.calls[0][0].ext).toEqual(['isolate']);

    await runner.stop();
    await runPromise;
  });

  it('resolveModules: matching label triggers module', async () => {
    const issue = makeIssue(24, ['need::isolate']);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 1,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      ext: [],
      moduleTriggers: { 'need::isolate': ['isolate'] },
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length > 0, 2_000);
    // Should fetch the issue to check labels
    expect(tracker.getIssue).toHaveBeenCalledWith(24);
    // Should resolve to ['isolate']
    expect(workflowRunImpl.mock.calls[0][0].ext).toEqual(['isolate']);

    await runner.stop();
    await runPromise;
  });

  it('resolveModules: non-matching label passes base ext', async () => {
    const issue = makeIssue(24, ['need::other']);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 1,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      ext: ['mock-server'],
      moduleTriggers: { 'need::isolate': ['isolate'] },
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length > 0, 2_000);
    // Issue has need::other, not need::isolate → only base ext
    expect(workflowRunImpl.mock.calls[0][0].ext).toEqual(['mock-server']);

    await runner.stop();
    await runPromise;
  });

  it('resolveModules: merges base ext with triggered modules', async () => {
    const issue = makeIssue(24, ['need::isolate', 'need::mock']);
    tracker = makeTracker([issue]);
    workflowRunImpl.mockResolvedValue({ success: false });

    const runner = new LoopRunner(tracker, {
      ...tmpPaths(),
      maxConcurrent: 1,
      pollIntervalMs: 50,
      statusIntervalMs: 10_000,
      requiredLabels: REQ,
      excludeLabels: EXC,
      shutdownTimeoutMs: 1_000,
      ext: ['base-module'],
      moduleTriggers: { 'need::isolate': ['isolate'], 'need::mock': ['mock-server'] },
      workflowRunnerFactory: () => ({ run: workflowRunImpl } as unknown as WorkflowRunner),
      qaRunnerFactory: () => ({ process: qaProcessImpl } as unknown as QARunner),
    });

    const runPromise = runner.start();
    await waitFor(() => workflowRunImpl.mock.calls.length > 0, 2_000);
    const resolved = workflowRunImpl.mock.calls[0][0].ext;
    expect(resolved).toContain('base-module');
    expect(resolved).toContain('isolate');
    expect(resolved).toContain('mock-server');
    expect(resolved).toHaveLength(3);

    await runner.stop();
    await runPromise;
  });

  });

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
