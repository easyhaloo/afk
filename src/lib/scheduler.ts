import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { TrackerProvider } from './core/tracker/types';
import { WorkflowRunner } from './workflows';
import { checkIssuePreconditions } from './preconditions';
import { PORTS, TIMEOUTS } from './constants';
import { logger } from './io';

export interface TaskData {
  iid: number;
  priority: number;
  baseBranch: string;
  createdAt: Date;
  retries: number;
}

export interface SchedulerOptions {
  maxConcurrent?: number;
  redisHost?: string;
  redisPort?: number;
  queueName?: string;
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
 * Event-driven task scheduler with BullMQ
 */
export class Scheduler {
  private queue: Queue<TaskData>;
  private worker: Worker<TaskData> | null = null;
  private redis: Redis;
  private tracker: TrackerProvider;
  private maxConcurrent: number;
  private startTime: number = 0;

  constructor(tracker: TrackerProvider, options: SchedulerOptions = {}) {
    const {
      maxConcurrent = 3,
      redisHost = 'localhost',
      redisPort = PORTS.REDIS_DEFAULT,
      queueName = 'afk-tasks',
    } = options;

    this.tracker = tracker;
    this.maxConcurrent = maxConcurrent;

    // Setup Redis connection
    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
    });

    // Setup BullMQ queue
    this.queue = new Queue<TaskData>(queueName, {
      connection: this.redis,
    });
  }

  /**
   * Start scheduler worker
   */
  async start(): Promise<void> {
    logger.info({ maxConcurrent: this.maxConcurrent }, 'scheduler starting');

    this.startTime = Date.now();

    // Create worker to process jobs
    this.worker = new Worker<TaskData>(
      'afk-tasks',
      async (job: Job<TaskData>) => {
        return this.processTask(job);
      },
      {
        connection: this.redis,
        concurrency: this.maxConcurrent,
      }
    );

    // Worker event handlers
    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id, iid: job.data.iid }, 'task completed');
    });

    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, iid: job?.data?.iid, err: err.message }, 'task failed');
    });

    this.worker.on('active', (job) => {
      logger.info({ jobId: job.id, iid: job.data.iid }, 'task started');
    });

    logger.info('scheduler started, listening for tasks');
  }

  /**
   * Stop scheduler
   */
  async stop(): Promise<void> {
    logger.info('scheduler stopping');

    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }

    await this.queue.close();
    await this.redis.quit();

    logger.info('scheduler stopped');
  }

  /**
   * Enqueue task for issue
   */
  async enqueue(iid: number, priority: number = 5, baseBranch: string = 'main'): Promise<string> {
    const job = await this.queue.add(
      `issue-${iid}`,
      {
        iid,
        priority,
        baseBranch,
        createdAt: new Date(),
        retries: 0,
      },
      {
        priority,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: TIMEOUTS.JOB_RETRY_DELAY,
        },
      }
    );

    logger.info({ iid, priority }, 'task enqueued');
    return job.id || '';
  }

  /**
   * Get failed jobs (dead letter queue)
   */
  async getFailedJobs(): Promise<Array<{ iid: number; attemptsMade: number; failedReason: string | null }>> {
    const jobs = await this.queue.getJobs(['failed']);
    return jobs.map(job => ({
      iid: job.data.iid,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
    }));
  }

  /**
   * Get scheduler status
   */
  async getStatus(): Promise<SchedulerStatus> {
    const counts = await this.queue.getJobCounts();
    const workers = await this.queue.getWorkers();

    return {
      queue: {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
      },
      workers: {
        active: workers.length,
        total: this.maxConcurrent,
      },
      uptime: this.startTime ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * Pause task processing for specific issue
   */
  async pauseTask(iid: number): Promise<void> {
    const jobs = await this.queue.getJobs(['waiting', 'active']);
    const job = jobs.find(j => j.data.iid === iid);

    if (job) {
      await job.moveToDelayed(Date.now() + TIMEOUTS.JOB_RESCHEDULE_DELAY);
      logger.info({ iid }, 'task paused');
    } else {
      throw new Error(`Task for issue #${iid} not found`);
    }
  }

  /**
   * Resume paused task
   */
  async resumeTask(iid: number): Promise<void> {
    const jobs = await this.queue.getJobs(['delayed']);
    const job = jobs.find(j => j.data.iid === iid);

    if (job) {
      await job.promote();
      logger.info({ iid }, 'task resumed');
    } else {
      throw new Error(`Delayed task for issue #${iid} not found`);
    }
  }

  /**
   * Poll tracker for ready issues and enqueue them
   * @param labels - label filter (default: ['mode::afk', 'stage::ready-for-issues'])
   * @param excludeLabels - Labels that exclude an issue from scheduling
   */
  async pollTracker(labels: string[] = ['mode::afk', 'stage::ready-for-issues'], excludeLabels: string[] = []): Promise<number> {
    logger.info({ labels }, 'polling tracker for ready issues');

    const issues = await this.tracker.listIssues({
      labels,
      state: 'opened',
    });

    let enqueued = 0;
    let skipped = 0;

    for (const issue of issues) {
      // Skip issues with exclude labels
      if (excludeLabels.length > 0 && issue.labels.some(l => excludeLabels.includes(l))) {
        skipped++;
        continue;
      }

      // O(1) per-issue lookup
      const job = await this.queue.getJob(`issue-${issue.id}`);
      if (job) continue;

      // Check preconditions
      const check = await checkIssuePreconditions(this.tracker, issue.id);
      if (!check.ok) {
        logger.info({ iid: issue.id, reason: check.reason }, 'issue skipped');
        skipped++;
        continue;
      }

      // Calculate priority based on labels
      const priority = this.calculatePriority(issue.labels);
      await this.enqueue(issue.id, priority);
      enqueued++;
    }

    logger.info({ found: issues.length, enqueued, skipped }, 'poll complete');
    return enqueued;
  }

  /**
   * Process task (run workflow)
   */
  private async processTask(job: Job<TaskData>): Promise<void> {
    const { iid, baseBranch } = job.data;

    logger.info({ iid }, 'processing issue');

    const runner = new WorkflowRunner(this.tracker);

    // Use platform-aware session name so it appears in dashboard TaskService filters
    const sessionName = this.tracker.platform === 'github'
      ? `afk-gh-${iid}`
      : `afk-gl-${iid}`;

    try {
      // Run full signal-driven workflow
      const result = await runner.run({
        iid,
        session: sessionName,
        targetBranch: baseBranch,
        baseBranch,
      });

      if (!result.success) {
        throw new Error('Workflow did not complete');
      }

      // Update labels
      await this.tracker.removeLabel(iid, 'stage::ready-for-issues');
      await this.tracker.removeLabel(iid, 'stage::afk-in-progress');
      await this.tracker.addLabel(iid, 'stage::qa');

    } catch (error) {
      // Update job data with retry count
      job.data.retries++;
      await job.updateData(job.data);

      throw error;
    }
  }

  /**
   * Calculate priority based on labels
   */
  private calculatePriority(labels: string[]): number {
    if (labels.includes('priority::high')) return 10;
    if (labels.includes('priority::medium')) return 5;
    if (labels.includes('priority::low')) return 1;
    return 5; // default
  }
}
