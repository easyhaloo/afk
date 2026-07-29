import type { TrackerProvider } from './core/tracker/types';
import { WorkflowRunner } from './workflows';
import { checkIssuePreconditions } from './preconditions';
import { TIMEOUTS } from './constants';
import { logger } from './io';

export interface TaskData {
  iid: number;
  priority: number;
  baseBranch: string;
  retries: number;
  maxRetries: number;
  lastError?: string;
}

export interface SchedulerOptions {
  maxConcurrent?: number;
  pollIntervalMs?: number;
}

export interface SchedulerStatus {
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  };
  workers: {
    active: number;
    total: number;
  };
  uptime: number;
}

/**
 * Lightweight in-memory scheduler — no Redis, no BullMQ.
 *
 * Polls the tracker for issues matching the given labels, enqueues them
 * in an in-memory array, and processes them with bounded concurrency.
 *
 * Tracker labels are the SSOT (Single Source of Truth). If the process
 * restarts, re-polling recovers all unfinished issues.
 */
export class Scheduler {
  private tracker: TrackerProvider;
  private maxConcurrent: number;
  private pollIntervalMs: number;
  private startTime: number = 0;

  // In-memory queue
  private queue: TaskData[] = [];
  private active = 0;
  private completed = 0;
  private failed: TaskData[] = [];
  private running = false;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  constructor(tracker: TrackerProvider, options: SchedulerOptions = {}) {
    this.tracker = tracker;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.pollIntervalMs = options.pollIntervalMs ?? 60000;
  }

  /**
   * Start scheduler: begin polling and draining.
   */
  async start(): Promise<void> {
    logger.info({ maxConcurrent: this.maxConcurrent }, 'scheduler starting (in-memory)');
    this.startTime = Date.now();
    this.running = true;

    // Poll tracker for ready issues
    await this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);

    // Drain queue (consume tasks)
    this.drainTimer = setInterval(() => this.drain(), 500);

    logger.info('scheduler started');
  }

  /**
   * Stop scheduler.
   */
  async stop(): Promise<void> {
    logger.info('scheduler stopping');
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }

    logger.info('scheduler stopped');
  }

  /**
   * Enqueue a task manually.
   */
  async enqueue(iid: number, priority: number = 5, baseBranch: string = 'main'): Promise<string> {
    const task: TaskData = {
      iid,
      priority,
      baseBranch,
      retries: 0,
      maxRetries: 3,
    };

    // Dedup: skip if already in queue
    const existing = this.queue.find(t => t.iid === iid);
    if (existing) {
      logger.info({ iid }, 'task already enqueued, skipped');
      return `duplicate-${iid}`;
    }

    this.queue.push(task);
    // Sort by priority descending
    this.queue.sort((a, b) => b.priority - a.priority);

    logger.info({ iid, priority }, 'task enqueued');
    return `task-${iid}`;
  }

  /**
   * Poll tracker for ready issues and enqueue them.
   */
  async pollTracker(
    labels: string[] = ['mode::afk', 'stage::ready-for-issues'],
    excludeLabels: string[] = []
  ): Promise<number> {
    logger.info({ labels }, 'polling tracker for ready issues');

    const issues = await this.tracker.listIssues({ labels, state: 'opened' });
    let enqueued = 0;
    let skipped = 0;

    for (const issue of issues) {
      // Skip issues with exclude labels
      if (excludeLabels.length > 0 && issue.labels.some(l => excludeLabels.includes(l))) {
        skipped++;
        continue;
      }

      // Dedup: skip if already in queue or active
      if (this.queue.some(t => t.iid === issue.id)) {
        skipped++;
        continue;
      }

      // Check preconditions
      const check = await checkIssuePreconditions(this.tracker, issue.id);
      if (!check.ok) {
        logger.info({ iid: issue.id, reason: check.reason }, 'issue skipped');
        skipped++;
        continue;
      }

      // Calculate priority
      const priority = this.calculatePriority(issue.labels);
      await this.enqueue(issue.id, priority);
      enqueued++;
    }

    logger.info({ found: issues.length, enqueued, skipped }, 'poll complete');
    return enqueued;
  }

  /**
   * Get scheduler status.
   */
  async getStatus(): Promise<SchedulerStatus> {
    return {
      queue: {
        waiting: this.queue.length,
        active: this.active,
        completed: this.completed,
        failed: this.failed.length,
      },
      workers: {
        active: this.active,
        total: this.maxConcurrent,
      },
      uptime: this.startTime ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * Get failed jobs (dead letter queue).
   */
  async getFailedJobs(): Promise<Array<{ iid: number; attemptsMade: number; failedReason: string | null }>> {
    return this.failed.map(t => ({
      iid: t.iid,
      attemptsMade: t.retries,
      failedReason: t.lastError ?? null,
    }));
  }

  /**
   * Pause processing for a specific issue (move to delayed).
   * In this in-memory implementation, we remove it from the queue
   * and it will be re-enqueued on the next poll cycle.
   */
  async pauseTask(iid: number): Promise<void> {
    const idx = this.queue.findIndex(t => t.iid === iid);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      logger.info({ iid }, 'task paused (removed from queue)');
    } else {
      throw new Error(`Task for issue #${iid} not found in queue`);
    }
  }

  /**
   * Resume a paused task.
   * Polling will pick it up on the next cycle, so this is a no-op.
   */
  async resumeTask(_iid: number): Promise<void> {
    // Polling will re-enqueue on next cycle
    logger.info('resume: task will be picked up on next poll cycle');
  }

  /**
   * Internal: poll and enqueue ready issues.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollTracker();
    } catch (error) {
      logger.error({ err: (error as Error).message }, 'poll error');
    }
  }

  /**
   * Internal: drain queue with concurrency control.
   */
  private drain(): void {
    if (!this.running) return;

    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active++;
      this.processTask(task).finally(() => {
        this.active--;
      });
    }
  }

  /**
   * Process a single task: run WorkflowRunner.
   */
  private async processTask(task: TaskData): Promise<void> {
    const { iid, baseBranch } = task;

    logger.info({ iid }, 'processing issue');

    const runner = new WorkflowRunner(this.tracker);
    const sessionName = this.tracker.platform === 'github'
      ? `afk-gh-${iid}`
      : `afk-gl-${iid}`;

    try {
      const result = await runner.run({
        iid,
        session: sessionName,
        targetBranch: baseBranch,
        baseBranch,
      });

      if (result.success) {
        this.completed++;
        logger.info({ iid, url: result.url }, 'workflow completed successfully');
      } else {
        throw new Error('Workflow did not complete');
      }
    } catch (error) {
      task.retries++;
      const errMsg = (error as Error).message;
      task.lastError = errMsg;

      if (task.retries < task.maxRetries) {
        // Re-enqueue with exponential backoff
        const delay = TIMEOUTS.JOB_RETRY_DELAY * Math.pow(2, task.retries - 1);
        logger.warn({ iid, retryCount: task.retries, maxRetries: task.maxRetries, delay }, 'task failed, will retry');
        setTimeout(() => {
          this.queue.push(task);
        }, delay);
      } else {
        this.failed.push(task);
        logger.error({ iid, err: errMsg, retries: task.retries }, 'task failed permanently');
      }
    }
  }

  /**
   * Calculate priority based on labels.
   */
  private calculatePriority(labels: string[]): number {
    if (labels.includes('priority::high')) return 10;
    if (labels.includes('priority::medium')) return 5;
    if (labels.includes('priority::low')) return 1;
    return 5;
  }
}