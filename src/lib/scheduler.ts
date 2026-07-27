import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { GitLabClient } from './gitlab.js';
import { WorkflowRunner } from './workflows.js';
import { checkIssuePreconditions } from './preconditions.js';

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
  private gitlab: GitLabClient;
  private maxConcurrent: number;
  private startTime: number = 0;

  constructor(gitlab: GitLabClient, options: SchedulerOptions = {}) {
    const {
      maxConcurrent = 3,
      redisHost = 'localhost',
      redisPort = 6379,
      queueName = 'afk-tasks',
    } = options;

    this.gitlab = gitlab;
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
    console.log(`🚀 Starting scheduler (max concurrent: ${this.maxConcurrent})...`);

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
      console.log(`✅ Task ${job.id} completed (issue #${job.data.iid})`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`❌ Task ${job?.id} failed (issue #${job?.data.iid}):`, err.message);
    });

    this.worker.on('active', (job) => {
      console.log(`▶️  Task ${job.id} started (issue #${job.data.iid})`);
    });

    console.log('✅ Scheduler started');
    console.log('   Listening for tasks...');
  }

  /**
   * Stop scheduler
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping scheduler...');

    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }

    await this.queue.close();
    await this.redis.quit();

    console.log('✅ Scheduler stopped');
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
          delay: 60000, // 1 minute
        },
      }
    );

    console.log(`📥 Enqueued task for issue #${iid} (priority: ${priority})`);
    return job.id || '';
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
      await job.moveToDelayed(Date.now() + 3600000); // Delay 1 hour
      console.log(`⏸️  Paused task for issue #${iid}`);
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
      console.log(`▶️  Resumed task for issue #${iid}`);
    } else {
      throw new Error(`Delayed task for issue #${iid} not found`);
    }
  }

  /**
   * Poll GitLab for ready issues and enqueue them
   * @param labels - GitLab label filter (default: ['stage::ready-for-implement'])
   * @param excludeLabels - Labels that exclude an issue from scheduling
   */
  async pollGitLab(labels: string[] = ['stage::ready-for-implement'], excludeLabels: string[] = []): Promise<number> {
    console.log('🔍 Polling GitLab for ready issues...');

    const issues = await this.gitlab.listIssues({
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
      const job = await this.queue.getJob(`issue-${issue.iid}`);
      if (job) continue;

      // Check preconditions
      const check = await checkIssuePreconditions(this.gitlab, issue.iid);
      if (!check.ok) {
        console.log(`   #${issue.iid}: skipped (${check.reason})`);
        skipped++;
        continue;
      }

      // Calculate priority based on labels
      const priority = this.calculatePriority(issue.labels);
      await this.enqueue(issue.iid, priority);
      enqueued++;
    }

    console.log(`   Found ${issues.length} ready issues: ${enqueued} enqueued, ${skipped} skipped`);
    return enqueued;
  }

  /**
   * Process task (run workflow)
   */
  private async processTask(job: Job<TaskData>): Promise<void> {
    const { iid, baseBranch } = job.data;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing issue #${iid}`);
    console.log(`${'='.repeat(60)}\n`);

    const runner = new WorkflowRunner(this.gitlab);

    try {
      // Run full signal-driven workflow
      const result = await runner.run({
        iid,
        session: `afk-${iid}`,
        targetBranch: baseBranch,
        baseBranch,
      });

      if (!result.success) {
        throw new Error('Workflow did not complete');
      }

      // Update labels
      await this.gitlab.removeLabel(iid, 'stage::ready-for-implement');
      await this.gitlab.removeLabel(iid, 'stage::afk-in-progress');
      await this.gitlab.addLabel(iid, 'stage::qa');

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
