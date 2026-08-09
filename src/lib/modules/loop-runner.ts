import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowRunner } from '../workflows';
import { QARunner } from './qa-runner';
import { getWorkflowConfig } from '../core/config/manager';
import { logger } from '../io';
import type { ManagementProviderBundle, ProviderBundle } from '../core/providers';
import { ManagementBacklogProvider } from '../core/backlog/management-provider';
import { resolveAgentProviderName } from '../agents';
import type { AgentProviderName } from '../agents/types';

export interface LoopRunnerOptions {
  /** Max simultaneous implement chains (WorkflowRunner instances). */
  maxConcurrent: number;
  /** Backlog polling interval in ms. */
  pollIntervalMs: number;
  /** Periodic status print interval in ms. */
  statusIntervalMs: number;
  /** Max wait for in-flight work on SIGTERM, in ms. */
  shutdownTimeoutMs: number;
  /** If set, the runner stops itself after this many successful completions. */
  maxIterations?: number;
  /** Factory for WorkflowRunner — overridable for tests. */
  workflowRunnerFactory?: (providers: ProviderBundle, config: import('../core/config/manager').WorkflowConfig) => WorkflowRunner;
  /** Factory for QARunner — overridable for tests. */
  qaRunnerFactory?: (providers: ManagementProviderBundle, config: import('../core/config/manager').WorkflowConfig) => QARunner;
  /** Where to write this process's pid (so `afk loop stop` can find it). */
  pidFilePath?: string;
  /** Where to write status JSON periodically (so `afk loop status` can read it). */
  statusFilePath?: string;
  /** Lifecycle modules to activate (e.g., ['isolate']). */
  ext?: string[];
  /** Module parameters (e.g., ['isolate.auto=true']). */
  extParams?: string[];
  /**
   * Label → modules mapping for dynamic per-issue module activation.
   * When an issue has a matching label, the corresponding modules are added
   * to the `ext` list for that issue's workflow run.
   * E.g. { 'need::isolate': ['isolate'] }
   */
  moduleTriggers?: Record<string, string[]>;
  /** Canonical providers for backlog-aware execution. */
  providers: ProviderBundle;
  /** Agent provider shared by implementation and QA for each chain. */
  agentProvider?: AgentProviderName;
}

export interface ChainContext {
  iid: string;
  session: string;
  startedAt: number;
}

export interface LoopStatus {
  implement: { active: number; ids: string[] };
  qa: { active: string | null; queue: string[] };
  totals: { completed: number; failed: number; started: number };
  uptimeMs: number;
  lastError: Record<string, string>;
}

interface InternalOptions {
  maxConcurrent: number;
  pollIntervalMs: number;
  statusIntervalMs: number;
  shutdownTimeoutMs: number;
  maxIterations: number | undefined;
  workflowRunnerFactory: (providers: ProviderBundle, config: import('../core/config/manager').WorkflowConfig) => WorkflowRunner;
  qaRunnerFactory: (providers: ManagementProviderBundle, config: import('../core/config/manager').WorkflowConfig) => QARunner;
  pidFilePath: string;
  statusFilePath: string;
  ext: string[] | undefined;
  extParams: string[] | undefined;
  moduleTriggers: Record<string, string[]>;
  providers: ProviderBundle;
  agentProvider: AgentProviderName;
}

const DEFAULTS = {
  maxConcurrent: 3,
  pollIntervalMs: 60_000,
  statusIntervalMs: 30_000,
  shutdownTimeoutMs: 300_000,
  pidFilePath: path.join(os.homedir(), '.afk', 'loop.pid'),
  statusFilePath: path.join(os.homedir(), '.afk', 'loop-status.json'),
};

const POLL_RETRY_DELAY_MS = 5_000;

/**
 * LoopRunner — drives the full pipeline (implement → QA → done) for every
 * canonical `ready`/`afk` backlog item, continuously.
 *
 * Two pools:
 *   - implement: N parallel `WorkflowRunner` instances, bounded by
 *     `maxConcurrent`.
 *   - qa: a single `QARunner` slot + FIFO queue. QA is serial by design.
 *
 * Each issue flows: poll → implement → qaQueue → qa → done/failed.
 *
 * Provider state remains the SSOT: the in-memory `inFlight` set is per-process
 * and rebuilt on restart. A reservation is held from poll until the chain
 * finishes (implement failure or QA completion release it — success keeps it
 * reserved while QA is queued, so poll can't double-start).
 */
export class LoopRunner {
  private readonly opts: InternalOptions;
  private readonly managementProviders: ManagementProviderBundle;

  // Two pools + queue
  private inImplement = new Map<string, ChainContext>();
  private inQA: ChainContext | null = null;
  private qaQueue: string[] = [];
  // Serial QA executor: each enqueue appends a segment to this chain, so QA
  // runs FIFO, one at a time, with zero polling.
  private qaChain: Promise<void> = Promise.resolve();

  // Dedup + counters
  private inFlight = new Set<string>();
  private polling = false; // true while a poll() tick is in flight
  private completed = 0;
  private failed = 0;
  private started = 0;
  private lastError = new Map<string, string>();
  private startTime = 0;

  // Lifecycle
  private running = false;
  private stopping = false;
  private stopResolve: (() => void) | null = null;

  // Timers
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly providers: ProviderBundle, options: Partial<LoopRunnerOptions> = {}) {
    this.managementProviders = {
      backlog: new ManagementBacklogProvider(providers.backlog),
      branches: providers.branches,
      changes: providers.changes,
    };
    this.opts = {
      maxConcurrent: options.maxConcurrent ?? DEFAULTS.maxConcurrent,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      statusIntervalMs: options.statusIntervalMs ?? DEFAULTS.statusIntervalMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs,
      maxIterations: options.maxIterations,
      workflowRunnerFactory: options.workflowRunnerFactory ?? ((p, cfg) => new WorkflowRunner(p, { config: cfg })),
      qaRunnerFactory: options.qaRunnerFactory ?? ((p, cfg) => new QARunner(p, cfg)),
      pidFilePath: options.pidFilePath ?? DEFAULTS.pidFilePath,
      statusFilePath: options.statusFilePath ?? DEFAULTS.statusFilePath,
      ext: options.ext,
      extParams: options.extParams,
      moduleTriggers: options.moduleTriggers ?? {},
      providers: this.providers,
      agentProvider: resolveAgentProviderName(options.agentProvider ?? getWorkflowConfig().agentDefault),
    };
  }

  /**
   * Start the loop: initial poll, then arm three timers.
   * Resolves when the loop exits (--max-iterations reached or stop() called).
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('LoopRunner already started');
    }
    this.running = true;
    this.startTime = Date.now();
    this.writePidFile();

    this.emitEvent(`started (maxConcurrent=${this.opts.maxConcurrent}, poll=${this.opts.pollIntervalMs}ms, status=${this.opts.statusIntervalMs}ms)`);
    logger.info(
      {
        maxConcurrent: this.opts.maxConcurrent,
        pollIntervalMs: this.opts.pollIntervalMs,
        pid: process.pid,
        pidFile: this.opts.pidFilePath,
      },
      'loop started'
    );

    // Initial poll — don't wait a full interval to notice the first issue
    void this.poll();

    this.pollTimer = setInterval(() => void this.poll(), this.opts.pollIntervalMs);
    this.statusTimer = setInterval(() => this.printStatus(), this.opts.statusIntervalMs);

    // Wait until stop() resolves
    await new Promise<void>(resolve => {
      this.stopResolve = resolve;
    });
  }

  /**
   * Stop the loop: flip running=false, clear timers, drain in-flight up to
   * shutdownTimeoutMs, then resolve.
   */
  async stop(): Promise<void> {
    if (!this.running || this.stopping) return;
    this.stopping = true;
    this.running = false;
    this.emitEvent('stopping: clearing timers and draining...');

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }

    const drain = this.waitForDrain();
    // Race with a typed timeout. The timer must be cleared after the race:
    // otherwise a clean drain leaves the event loop alive for
    // shutdownTimeoutMs (300s default), and a direct stop() caller hangs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), this.opts.shutdownTimeoutMs);
    });
    let winner: 'drained' | 'timeout';
    try {
      winner = await Promise.race([drain, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (winner === 'timeout') {
      logger.warn(
        {
          inImplement: this.inImplement.size,
          inQA: this.inQA?.iid ?? null,
          qaQueue: this.qaQueue.length,
        },
        'shutdown timeout — force exit'
      );
      this.emitEvent(
        `shutdown timeout: implement=${this.inImplement.size} qa=${this.inQA?.iid ?? '-'} qaQueue=${this.qaQueue.length} (force exit)`
      );
    } else {
      this.emitEvent('stopped: all in-flight drained');
    }

    this.deletePidFile();
    if (this.stopResolve) this.stopResolve();
  }

  /**
   * Snapshot of current state — for status output and external queries.
   */
  getStatus(): LoopStatus {
    return {
      implement: {
        active: this.inImplement.size,
        ids: [...this.inImplement.keys()],
      },
      qa: {
        active: this.inQA?.iid ?? null,
        queue: [...this.qaQueue],
      },
      totals: {
        completed: this.completed,
        failed: this.failed,
        started: this.started,
      },
      uptimeMs: this.startTime ? Date.now() - this.startTime : 0,
      lastError: Object.fromEntries(this.lastError),
    };
  }

  // ── Private: pool drains ───────────────────────────────────────────────────

  private async waitForDrain(): Promise<'drained'> {
    // Drained = no implement chains, no active QA, and no QA waiting on the
    // chain (stop() drops queued QA segments, so queue must also be empty).
    const drained = () =>
      this.inImplement.size === 0 && this.inQA === null && this.qaQueue.length === 0;
    if (drained()) return 'drained';
    return new Promise<'drained'>(resolve => {
      const check = () => {
        if (drained()) resolve('drained');
        else if (!this.running && !this.stopping) resolve('drained');
        else setTimeout(check, 100);
      };
      check();
    });
  }

  /**
   * Pull runnable backlog items from the provider and fire implement chains.
   * Tracker errors are logged and swallowed — the loop never dies from a
   * single bad poll.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;
    // Re-entrancy guard: a tick can outlive the interval (slow listIssues +
    // per-candidate precondition calls), and two overlapping ticks would both
    // see inFlight miss the same id and double-start the issue.
    if (this.polling) return;
    this.polling = true;
    logger.info({ tickIntervalMs: this.opts.pollIntervalMs }, 'poll tick begin');
    try {
      // Rework is a runnable AFK state too. Keep the provider state explicit
      // instead of making rework look like ready: the active rework record
      // remains the source of implementation feedback, while the loop owns
      // the same claim/execute lifecycle for both states.
      const [readyIssues, reworkIssues] = await Promise.all([
        this.providers.backlog.list({ state: 'ready', executionMode: 'afk' }),
        this.providers.backlog.list({ state: 'rework', executionMode: 'afk' }),
      ]);
      const issues = [...readyIssues, ...reworkIssues].filter((issue, index, all) =>
        all.findIndex(candidate => candidate.id === issue.id) === index,
      );
      logger.info({ candidates: issues.length, candidateIds: issues.map(i => i.id) }, 'poll candidates listed');

      let enqueued = 0;
      let skipped = 0;

      for (const issue of issues) {
        const issueId = String(issue.id);
        if (!this.running) break;

        if (this.inFlight.has(issueId)) { skipped++; continue; }
        // Cap reached: later issues can't start either — break, don't continue.
        if (this.inImplement.size >= this.opts.maxConcurrent) { skipped++; break; }

        // Reserve BEFORE any await so overlapping ticks cannot double-start.
        this.inFlight.add(issueId);
        const check = { ok: await this.providers.backlog.isRunnable(issue) };
        if (!check.ok) {
          this.inFlight.delete(issueId);
          logger.info({ iid: issueId, reason: (check as any).reason }, 'issue skipped by preconditions');
          skipped++;
          continue;
        }

        this.inImplement.set(issueId, { iid: issueId, session: '', startedAt: 0 });
        this.started++;
        enqueued++;
        logger.info({ iid: issueId, inImplement: this.inImplement.size }, 'backlog enqueued for implement');
        // Fire-and-forget — chain manages its own inImplement membership
        void this.runChain(issueId);
      }

      logger.info({ found: issues.length, enqueued, skipped }, 'poll complete');
    } catch (error) {
      logger.error({ err: error }, 'poll error');
      this.emitEvent(`poll error: ${(error as Error).message}`);
      // Brief backoff so we don't hammer a failing API
      await new Promise(r => setTimeout(r, POLL_RETRY_DELAY_MS));
    } finally {
      this.polling = false;
    }
  }

  /**
   * Implement chain: WorkflowRunner → on success, push to qaQueue.
   * Errors never crash the loop.
   */
  private async runChain(iid: string, projectName?: string): Promise<void> {
    const session = `afk-${iid}-${Date.now()}`;
    const ctx: ChainContext = { iid, session, startedAt: Date.now() };
    this.inImplement.set(iid, ctx);
    this.emitEvent(`#${iid} implement started (session=${session})`);
    logger.info({ iid, session, projectName }, 'implement chain starting');

    const backlog = await this.providers.backlog.get(iid);
    const parent = backlog.parentId ? await this.providers.backlog.get(backlog.parentId) : undefined;
    const baseBranch = parent?.branchName ?? getWorkflowConfig().targetBranch ?? 'main';

    try {
      const resolvedExt = await this.resolveModules(iid);
      logger.info({ iid, resolvedExt }, 'modules resolved');
      const config = { ...getWorkflowConfig(), agentDefault: this.opts.agentProvider };
      const runner = this.opts.workflowRunnerFactory(this.providers, config);
      const result = await runner.run({
        session,
        projectName,
        targetBranch: baseBranch,
        baseBranch,
        ext: resolvedExt,
        extParams: this.opts.extParams,
        backlogId: String(iid),
        executionMode: 'batch',
        agentProvider: this.opts.agentProvider,
      });
      logger.info({ iid, success: result.success, url: result.url }, 'WorkflowRunner.run returned');

      if (result.success) {
        const elapsed = formatDuration(Date.now() - ctx.startedAt);
        this.emitEvent(`${iid} implement → verification (${elapsed})`);
        this.enqueueQA(iid);
        logger.info({ iid, elapsed, url: result.url }, 'implement succeeded; queued for QA');
      } else if (result.skipped === 'not_claimed') {
        this.inFlight.delete(iid);
        this.emitEvent(`${iid} implement skipped (claim unavailable)`);
        logger.info({ iid }, 'implement skipped because backlog claim was unavailable');
      } else {
        // WorkflowRunner terminalized the failure in the provider.
        this.failed++;
        // Release the reservation: a failed issue must be re-pickable once
        // a human can requeue the item after resolving the failure.
        this.inFlight.delete(iid);
        this.lastError.set(iid, 'implement-failed');
        this.emitEvent(`${iid} implement failed → blocked/hitl`);
        logger.warn({ iid }, 'implement returned unsuccessful');
      }
    } catch (error) {
      // Should be rare: WorkflowRunner catches its own errors, but if it
      // throws (e.g. before its try/catch), we still need to keep the loop
      // alive and mark the issue.
      const msg = (error as Error).message;
      this.failed++;
      this.inFlight.delete(iid);
      this.lastError.set(iid, `implement-crash: ${msg}`);
      logger.error({ iid, err: error }, 'implement chain crashed');
        this.emitEvent(`${iid} implement crashed → blocked/hitl: ${msg}`);
      try {
        await this.providers.backlog.transition(String(iid), 'blocked', { reason: msg });
        await this.providers.backlog.setExecutionMode(String(iid), 'hitl');
      } catch { /* best-effort */ }
    } finally {
      this.inImplement.delete(iid);
      logger.info({ iid, remainingInImplement: this.inImplement.size }, 'implement chain finished');
    }
  }

  /**
   * Resolve activated modules from provider-neutral business tags.
   *
   * 1. Start with the static `--ext` list (if any)
   * 2. If `moduleTriggers` is configured, fetch the item and check its tags
   * 3. Union the triggered modules with the base list
   *
   * On fetch failure, falls back to the static `--ext` list (doesn't break the
   * loop — the caller handles the error path).
   */
  private async resolveModules(iid: string): Promise<string[] | undefined> {
    const triggers = this.opts.moduleTriggers;
    const base = this.opts.ext ?? [];

    // No triggers configured → use static list
    if (!triggers || Object.keys(triggers).length === 0) {
      return base.length > 0 ? base : undefined;
    }

    try {
      const item = await this.providers.backlog.get(iid);
      const merged = new Set(base);

      for (const [tag, modules] of Object.entries(triggers)) {
        if (item.tags.includes(tag)) {
          for (const mod of modules) {
            merged.add(mod);
          }
        }
      }

      return [...merged];
    } catch (err) {
      logger.warn({ iid, err }, 'failed to resolve modules from tags, falling back to static ext');
      return base.length > 0 ? base : undefined;
    }
  }

  /**
   * Enqueue an issue for QA. Appends to the serial promise chain — QA runs
   * FIFO, one at a time, with no polling timer.
   */
  private enqueueQA(iid: string): void {
    this.qaQueue.push(iid);
    this.qaChain = this.qaChain
      .then(() => this.runQA())
      // runQA never rejects (every path is caught), but keep the chain alive
      // even if a future change breaks that invariant.
      .catch(err => logger.error({ err }, 'qa chain segment crashed'));
  }

  /**
   * Run QARunner.process for the head of qaQueue, route result.
   * Serial by design — chain segments execute one after another.
   */
  private async runQA(): Promise<void> {
    // Dequeue first so a stop() that drops the segment still drains cleanly.
    const iid = this.qaQueue.shift();
    if (iid === undefined) return;
    if (!this.running) return; // stop() in progress: drop queued QA, exit soon
    logger.info({ iid, qaQueueRemaining: this.qaQueue.length }, 'qa dequeued');

    const ctx: ChainContext = {
      iid,
      session: `qa-${iid}-${Date.now()}`,
      startedAt: Date.now(),
    };

    // Re-check the issue is still ready for QA (could be already done/hitl
    // by another process since the chain finished).
    try {
      const item = await this.providers.backlog.get(String(iid));
      if (item.state !== 'verification') {
        logger.info({ iid, state: item.state }, 'backlog no longer needs QA, skipping');
        this.inFlight.delete(iid);
        return;
      }
    } catch (err) {
      logger.warn({ iid, err }, 're-check failed, proceeding with QA');
    }

    this.inQA = ctx;
      this.emitEvent(`${iid} QA started`);
    logger.info({ iid, session: ctx.session }, 'qa chain starting');

    try {
      const qa = this.opts.qaRunnerFactory(this.managementProviders, {
        ...getWorkflowConfig(),
        agentDefault: this.opts.agentProvider,
      });
      const result = await qa.process(iid);
      const elapsed = formatDuration(Date.now() - ctx.startedAt);

      if (result.success) {
        this.completed++;
        this.lastError.delete(iid);
        const terminal = result.autoMerged === false ? 'merge_ready (human approval)' : 'done';
        this.emitEvent(`${iid} QA passed → ${terminal} (${elapsed})${result.mrUrl ? ` change=${result.mrUrl}` : ''}`);
        logger.info({ iid, mrUrl: result.mrUrl, elapsed }, 'qa passed');
      } else if (result.rework) {
        this.lastError.delete(iid);
        this.emitEvent(`${iid} QA failed → rework/afk (${elapsed})`);
        logger.info({ iid, elapsed }, 'QA queued rework');
      } else {
        // QARunner terminalizes failure in the provider.
        this.failed++;
        this.lastError.set(iid, 'qa-failed');
        this.emitEvent(`${iid} QA failed → blocked/hitl (${elapsed})`);
        logger.warn({ iid, elapsed }, 'qa failed');
      }
    } catch (error) {
      const msg = (error as Error).message;
      this.failed++;
      this.lastError.set(iid, `qa-crash: ${msg}`);
      logger.error({ iid, err: error }, 'qa crashed');
      this.emitEvent(`#${iid} qa crashed: ${msg}`);
      try {
        await this.providers.backlog.transition(String(iid), 'blocked', { reason: msg });
        await this.providers.backlog.setExecutionMode(String(iid), 'hitl');
      } catch { /* best-effort */ }
    } finally {
      this.inQA = null;
      this.inFlight.delete(iid);
      logger.info({ iid, completed: this.completed, failed: this.failed }, 'qa chain finished');

      // Optional self-stop after N successful completions (testing)
      if (this.opts.maxIterations !== undefined && this.completed >= this.opts.maxIterations) {
        this.emitEvent(`max-iterations reached (${this.completed}/${this.opts.maxIterations}), stopping`);
        logger.info({ iid, completed: this.completed, maxIterations: this.opts.maxIterations }, 'max-iterations reached; stopping');
        // Don't await — let stop() handle drain in its own time
        void this.stop();
      }
    }
  }

  // ── Private: output ────────────────────────────────────────────────────────

  /**
   * Write a timestamped, parseable line to stdout + log to file.
   * Format: `[HH:MM:SS] loop  <message>`
   */
  private emitEvent(message: string): void {
    const ts = formatTimestamp();
    const line = `[${ts}] loop  ${message}\n`;
    process.stdout.write(line);
    logger.info({ event: message }, 'loop event');
    // Event-driven status refresh: keep `afk loop status` near-real-time
    // instead of only updating on the (slower) status heartbeat.
    this.writeStatusFile();
  }

  /**
   * Print a TUI-parseable status line.
   * Format: `[HH:MM:SS] loop  --- status: implement=N [ids] qa=N|[iid|null] queue=[ids] done=N failed=N uptime=Hh Mm`
   */
  private printStatus(): void {
    const s = this.getStatus();
    const ts = formatTimestamp();
    const implementIds = s.implement.ids.length ? `[${s.implement.ids.join(',')}]` : '[]';
    const qaActive = s.qa.active ?? '-';
    const qaQ = s.qa.queue.length ? `[${s.qa.queue.join(',')}]` : '[]';
    const uptime = formatDuration(s.uptimeMs);
    const line = `[${ts}] loop  --- status: implement=${s.implement.active} ${implementIds} qa=${qaActive} queue=${qaQ} done=${s.totals.completed} failed=${s.totals.failed} uptime=${uptime}\n`;
    process.stdout.write(line);
    this.writeStatusFile();
  }

  // ── Private: pid / status file I/O ─────────────────────────────────────────

  /**
   * Write `process.pid` to the pid file so `afk loop stop` can find us.
   * Uses O_EXCL ('wx') for atomic single-instance enforcement: if the file
   * exists and its pid is alive, another runner owns it — refuse to start.
   * A stale file (dead pid) is overwritten.
   */
  private writePidFile(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.pidFilePath), { recursive: true });
      let fd: number;
      try {
        fd = fs.openSync(this.opts.pidFilePath, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const existing = readPidFile(this.opts.pidFilePath);
        if (existing !== null && isProcessAlive(existing)) {
          throw new Error(`another loop is already running (pid=${existing})`);
        }
        // Stale file from a previous crash — take it over
        fd = fs.openSync(this.opts.pidFilePath, 'w');
      }
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch (err) {
      // Propagate: a live single-instance conflict or unwritable pid file must
      // abort startup (no pid file means stop/status can't find us).
      logger.warn(
        { err, path: this.opts.pidFilePath },
        'failed to write pid file'
      );
      throw err;
    }
  }

  /** Remove the pid file on graceful stop. Idempotent. */
  private deletePidFile(): void {
    try {
      fs.unlinkSync(this.opts.pidFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          { err, path: this.opts.pidFilePath },
          'failed to delete pid file'
        );
      }
    }
  }

  /**
   * Write status JSON for `afk loop status` to consume. Same content as
   * `getStatus()` plus pid and startedAt for human display.
   */
  private writeStatusFile(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.statusFilePath), { recursive: true });
      const status = this.getStatus();
      fs.writeFileSync(
        this.opts.statusFilePath,
        JSON.stringify(
          { ...status, pid: process.pid, startedAt: this.startTime, lastUpdateAt: Date.now() },
          null,
          2
        )
      );
    } catch (err) {
      logger.warn(
        { err, path: this.opts.statusFilePath },
        'failed to write status file'
      );
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Read a pid from a pid file; null if missing/invalid. */
function readPidFile(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/** True if a process with this pid exists (signal 0 probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but not ours; still alive
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
