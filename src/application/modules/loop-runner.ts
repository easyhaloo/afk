import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../../infrastructure/io/index';
import type { ProviderBundle } from '../providers';
import { parseWorkItemId } from '../../domain/backlog';
import { readExecutionManifest } from '../workflows/execution-manifest';
import { executeWorkItem } from '../workflows/execute-work-item';

export interface LoopRunnerOptions {
  /** Backlog polling interval in ms. */
  pollIntervalMs: number;
  /** Periodic status print interval in ms. */
  statusIntervalMs: number;
  /** Max wait for in-flight work on SIGTERM, in ms. */
  shutdownTimeoutMs: number;
  /** If set, the runner stops itself after this many successful completions. */
  maxIterations?: number;
  /** Exact backlog scope for the manifest-bound work item. */
  backlogIds: readonly string[];
  /** Workflow template passed to each execution. */
  template?: string;
  managedExecution: { workItemId: string; manifestPath: string };
  readManifest?: typeof readExecutionManifest;
  executeManagedWorkItem?: typeof executeWorkItem;
  /** Where to write this process's pid (so `afk loop stop` can find it). */
  pidFilePath?: string;
  /** Where to write status JSON periodically (so `afk loop status` can read it). */
  statusFilePath?: string;
}

export interface ChainContext {
  iid: string;
  session: string;
  startedAt: number;
}

export interface LoopStatus {
  execution: { active: number; ids: string[] };
  totals: { completed: number; failed: number; started: number };
  uptimeMs: number;
  lastError: Record<string, string>;
  infrastructureError?: string;
}

interface InternalOptions {
  pollIntervalMs: number;
  statusIntervalMs: number;
  shutdownTimeoutMs: number;
  maxIterations: number | undefined;
  backlogIds: ReadonlySet<string>;
  template: string | undefined;
  managedExecution: { backlogId: string; workItemId: string; manifestPath: string; providerRef?: string };
  readManifest: typeof readExecutionManifest;
  executeManagedWorkItem: typeof executeWorkItem;
  pidFilePath: string;
  statusFilePath: string;
}

const DEFAULTS = {
  pollIntervalMs: 60_000,
  statusIntervalMs: 30_000,
  shutdownTimeoutMs: 300_000,
  pidFilePath: path.join(os.homedir(), '.afk', 'loop.pid'),
  statusFilePath: path.join(os.homedir(), '.afk', 'loop-status.json'),
};

const POLL_RETRY_DELAY_MS = 5_000;

/**
 * LoopRunner schedules one manifest-bound ready/rework work item continuously.
 * Each attempt delegates the full lifecycle to executeWorkItem.
 *
 * Provider state remains the SSOT: the in-memory `inFlight` set is per-process
 * and rebuilt on restart. A reservation is held from poll until the chain
 * finishes, so poll cannot double-start an attempt.
 */
export class LoopRunner {
  private readonly opts: InternalOptions;
  private inExecution = new Map<string, ChainContext>();

  // Dedup + counters
  private inFlight = new Set<string>();
  private polling = false; // true while a poll() tick is in flight
  private completed = 0;
  private failed = 0;
  private started = 0;
  private lastError = new Map<string, string>();
  private startTime = 0;
  private infrastructureError?: string;

  // Lifecycle
  private running = false;
  private stopping = false;
  private stopResolve: (() => void) | null = null;

  // Timers
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly providers: ProviderBundle, options: Partial<LoopRunnerOptions> = {}) {
    if (options.backlogIds?.length !== 1 || !options.managedExecution?.manifestPath) {
      throw new Error('loop execution requires exactly one backlog ID, work item ID, and execution manifest');
    }
    const managedExecution = {
      backlogId: String(options.backlogIds![0]),
      workItemId: parseWorkItemId(options.managedExecution.workItemId).id,
      manifestPath: options.managedExecution.manifestPath,
    };
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      statusIntervalMs: options.statusIntervalMs ?? DEFAULTS.statusIntervalMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs,
      maxIterations: options.maxIterations,
      backlogIds: new Set(options.backlogIds.map(String)),
      template: options.template,
      managedExecution,
      readManifest: options.readManifest ?? readExecutionManifest,
      executeManagedWorkItem: options.executeManagedWorkItem ?? executeWorkItem,
      pidFilePath: options.pidFilePath ?? DEFAULTS.pidFilePath,
      statusFilePath: options.statusFilePath ?? DEFAULTS.statusFilePath,
    };
  }

  /**
   * Start the loop: initial poll, then arm polling and status timers.
   * Resolves when the loop exits (--max-iterations reached or stop() called).
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('LoopRunner already started');
    }
    this.infrastructureError = undefined;
    try {
      await this.validateManagedExecution();
    } catch (error) {
      this.infrastructureError = (error as Error).message;
      logger.error({ error: this.infrastructureError }, 'loop startup precondition failed');
      throw error;
    }
    this.running = true;
    this.startTime = Date.now();
    this.writePidFile();

    this.emitEvent(`started (poll=${this.opts.pollIntervalMs}ms, status=${this.opts.statusIntervalMs}ms)`);
    logger.info(
      {
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

  private async validateManagedExecution(): Promise<void> {
    const managed = this.opts.managedExecution;
    const manifest = await this.opts.readManifest(managed.manifestPath, managed.workItemId);
    const identity = parseWorkItemId(managed.workItemId);
    if (manifest.workItemId !== managed.workItemId || manifest.providerBacklogId !== managed.backlogId
      || Number(managed.backlogId) !== identity.issueNumber
      || manifest.tracker.platform !== identity.platform || manifest.tracker.projectKey !== identity.projectKey) {
      throw new Error(`execution manifest identity does not match work item ${managed.workItemId} and backlog ${managed.backlogId}`);
    }
    managed.providerRef = `${identity.platform}:${manifest.tracker.providerProjectId ?? identity.projectKey}#${identity.issueNumber}`;
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
          active: this.inExecution.size,
        },
        'shutdown timeout — force exit'
      );
      this.emitEvent(
        `shutdown timeout: execution=${this.inExecution.size} (force exit)`
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
      execution: {
        active: this.inExecution.size,
        ids: [...this.inExecution.keys()],
      },
      totals: {
        completed: this.completed,
        failed: this.failed,
        started: this.started,
      },
      uptimeMs: this.startTime ? Date.now() - this.startTime : 0,
      lastError: Object.fromEntries(this.lastError),
      ...(this.infrastructureError ? { infrastructureError: this.infrastructureError } : {}),
    };
  }

  // ── Private: pool drains ───────────────────────────────────────────────────

  private async waitForDrain(): Promise<'drained'> {
    const drained = () => this.inExecution.size === 0;
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
   * Pull the runnable work item from the provider and start its execution.
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
      const issues = [...readyIssues, ...reworkIssues]
        .filter((issue, index, all) => all.findIndex(candidate => candidate.id === issue.id) === index)
        .filter(issue => this.opts.backlogIds.has(String(issue.id)));
      logger.info({ candidates: issues.length, candidateIds: issues.map(i => i.id) }, 'poll candidates listed');

      let enqueued = 0;
      let skipped = 0;

      for (const issue of issues) {
        const issueId = String(issue.id);
        if (!this.running) break;

        if (this.inFlight.has(issueId)) { skipped++; continue; }

        // Reserve BEFORE any await so overlapping ticks cannot double-start.
        this.inFlight.add(issueId);
        const check = { ok: await this.providers.backlog.isRunnable(issue) };
        if (!check.ok) {
          this.inFlight.delete(issueId);
          logger.info({ iid: issueId, reason: (check as any).reason }, 'issue skipped by preconditions');
          skipped++;
          continue;
        }

        this.inExecution.set(issueId, { iid: issueId, session: '', startedAt: 0 });
        this.started++;
        enqueued++;
        logger.info({ iid: issueId, active: this.inExecution.size }, 'backlog enqueued for execution');
        void this.runManagedChain(issueId);
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

  private async runManagedChain(iid: string): Promise<void> {
    const managed = this.opts.managedExecution!;
    const startedAt = Date.now();
    this.inExecution.set(iid, { iid, session: managed.workItemId, startedAt });
    this.emitEvent(`${iid} execution started (workItemId=${managed.workItemId})`);
    try {
      const item = await this.providers.backlog.get(iid);
      const identity = parseWorkItemId(managed.workItemId);
      if (!managed.providerRef || (item.providerRef !== managed.workItemId && item.providerRef !== managed.providerRef)
        || (item.workItemId && item.workItemId !== managed.workItemId)
        || (item.project && (item.project.platform !== identity.platform || item.project.projectKey !== identity.projectKey))) {
        throw new Error(`backlog ${iid} work item identity does not match ${managed.workItemId}`);
      }
      const result = await this.opts.executeManagedWorkItem({
        workItemId: managed.workItemId,
        manifestPath: managed.manifestPath,
        template: this.opts.template,
      });
      const elapsed = formatDuration(Date.now() - startedAt);
      if (result.status === 'merge_ready' || result.status === 'done') {
        this.completed++;
        this.lastError.delete(iid);
        this.emitEvent(`${iid} execution completed → ${result.status} (${elapsed})${result.changeUrl ? ` change=${result.changeUrl}` : ''}`);
      } else if (result.status === 'rework') {
        this.lastError.delete(iid);
        this.emitEvent(`${iid} execution requested rework/afk (${elapsed})`);
      } else if (result.status === 'not_claimed') {
        this.emitEvent(`${iid} execution skipped (claim unavailable)`);
      } else {
        this.failed++;
        this.lastError.set(iid, 'execution-blocked');
        this.emitEvent(`${iid} execution failed → blocked/hitl (${elapsed})`);
      }
    } catch (error) {
      const message = (error as Error).message;
      this.failed++;
      this.lastError.set(iid, `execution: ${message}`);
      this.emitEvent(`${iid} execution failed: ${message}`);
      logger.error({ iid, err: error }, 'execution failed');
    } finally {
      this.inExecution.delete(iid);
      this.inFlight.delete(iid);
      if (this.opts.maxIterations !== undefined && this.completed >= this.opts.maxIterations) {
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
   * Format: `[HH:MM:SS] loop  --- status: execution=N [ids] done=N failed=N uptime=Hh Mm`
   */
  private printStatus(): void {
    const s = this.getStatus();
    const ts = formatTimestamp();
    const activeIds = s.execution.ids.length ? `[${s.execution.ids.join(',')}]` : '[]';
    const uptime = formatDuration(s.uptimeMs);
    const line = `[${ts}] loop  --- status: execution=${s.execution.active} ${activeIds} done=${s.totals.completed} failed=${s.totals.failed} uptime=${uptime}\n`;
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
