import { Command } from 'commander';
import chalk from 'chalk';
import { cpus } from 'os';
import { createTrackerClient } from '../lib/client-factory';
import { Scheduler } from '../lib/scheduler';
import { getSchedulerConfig } from '../lib/config-manager';
import { handleCommandError } from '../lib/cli-utils';
import { logger } from '../lib/io';

export function registerSchedulerCommands(program: Command): void {
  const scheduler = program
    .command('scheduler')
    .description('Lightweight in-memory task scheduler (no Redis required)');

  /**
   * start command
   */
  scheduler
    .command('start')
    .description('Start scheduler worker')
    .option('--max-concurrent <n>', 'Max concurrent tasks')
    .option('--poll-interval <seconds>', 'Tracker polling interval')
    .action(async (options) => {
      try {
        const cfg = getSchedulerConfig();
        const tracker = await createTrackerClient();
        const sched = new Scheduler(tracker, {
          maxConcurrent: options.maxConcurrent ? parseInt(options.maxConcurrent) : cfg.maxConcurrent,
          pollIntervalMs: (options.pollInterval ? parseInt(options.pollInterval) : cfg.pollInterval) * 1000,
        });

        await sched.start();
        console.log(chalk.dim('\nPress Ctrl+C to stop\n'));

        process.on('SIGINT', async () => {
          console.log('\n\nReceived SIGINT, shutting down...');
          await sched.stop();
          process.exit(0);
        });
        process.on('SIGTERM', async () => {
          console.log('\n\nReceived SIGTERM, shutting down...');
          await sched.stop();
          process.exit(0);
        });
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * status command
   */
  scheduler
    .command('status')
    .description('Check scheduler status')
    .action(async () => {
      try {
        const tracker = await createTrackerClient();
        const sched = new Scheduler(tracker);
        const status = await sched.getStatus();

        console.log(chalk.bold('\n📊 Scheduler Status:\n'));
        console.log(chalk.gray('Queue:'));
        console.log(`  Waiting:   ${chalk.yellow(status.queue.waiting)}`);
        console.log(`  Active:    ${chalk.green(status.queue.active)}`);
        console.log(`  Completed: ${chalk.blue(status.queue.completed)}`);
        console.log(`  Failed:    ${chalk.red(status.queue.failed)}`);
        console.log();
        console.log(`  Workers:   ${status.workers.active}/${status.workers.total}`);

        if (status.uptime > 0) {
          const uptimeMin = Math.floor(status.uptime / 60000);
          const uptimeHr = Math.floor(uptimeMin / 60);
          console.log(chalk.gray(`\nUptime: ${uptimeHr}h ${uptimeMin % 60}m`));
        }

        await sched.stop();
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * enqueue command
   */
  scheduler
    .command('enqueue')
    .description('Manually enqueue task for issue')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .option('--priority <n>', 'Priority (1-10)', '5')
    .option('--branch <branch>', 'Base branch')
    .action(async (options) => {
      try {
        const tracker = await createTrackerClient();
        const sched = new Scheduler(tracker);

        const jobId = await sched.enqueue(
          options.iid,
          parseInt(options.priority),
          options.branch ?? (process.env.AFK_TARGET_BRANCH || 'main')
        );

        console.log(chalk.green(`✅ Task enqueued (job ID: ${jobId})`));
        await sched.stop();
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * pause command
   */
  scheduler
    .command('pause')
    .description('Pause task for issue')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .action(async (options) => {
      try {
        const tracker = await createTrackerClient();
        const sched = new Scheduler(tracker);

        await sched.pauseTask(options.iid);
        console.log(chalk.green(`✅ Task for issue #${options.iid} paused`));
        await sched.stop();
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * resume command
   */
  scheduler
    .command('resume')
    .description('Resume paused task')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .action(async (options) => {
      try {
        const tracker = await createTrackerClient();
        const sched = new Scheduler(tracker);

        await sched.resumeTask(options.iid);
        console.log(chalk.green(`✅ Task for issue #${options.iid} resumed`));
        await sched.stop();
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * poll command
   */
  scheduler
    .command('poll')
    .description('Manually poll tracker for ready issues')
    .option('--label <label>', 'Label to filter (can be repeated)')
    .action(async (options) => {
      try {
        const tracker = await createTrackerClient();
        const sched = new Scheduler(tracker);

        const cfg = getSchedulerConfig();
        const labels: string[] = options.label
          ? Array.isArray(options.label) ? options.label : [options.label]
          : cfg.requiredLabels;

        const enqueued = await sched.pollTracker(labels, cfg.excludeLabels);
        console.log(chalk.green(`✅ Polling complete (${enqueued} tasks enqueued)`));
        await sched.stop();
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * dlq command — list failed jobs
   */
  scheduler
    .command('dlq')
    .description('List failed jobs')
    .action(async () => {
      try {
        const tracker = await createTrackerClient();
        const sched = new Scheduler(tracker);
        const failedJobs = await sched.getFailedJobs();

        if (failedJobs.length === 0) {
          console.log(chalk.gray('  No failed jobs.'));
          await sched.stop();
          return;
        }

        console.log(chalk.bold(`\n📋 Failed Jobs (${failedJobs.length}):\n`));
        console.log(chalk.gray('  IID   Fails  Last Error'));
        console.log(chalk.gray('  ' + '─'.repeat(70)));

        for (const job of failedJobs) {
          const err = job.failedReason ?? 'unknown';
          const truncated = err.length > 60 ? err.slice(0, 60) + '…' : err;
          console.log(
            `  ${chalk.red(String(job.iid).padEnd(6))}` +
            `${chalk.yellow(String(job.attemptsMade).padEnd(6))}` +
            chalk.dim(truncated)
          );
        }
        console.log();
        await sched.stop();
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * run command — wave-based parallel execution
   */
  scheduler
    .command('run')
    .description('Scan ready issues, build DAG, execute wave-by-wave')
    .option('--concurrency <n>', 'Max parallel jobs per wave', parseInt)
    .action(async (options) => {
      try {
        const tracker = await createTrackerClient();
        const cfg = getSchedulerConfig();
        const concurrency = options.concurrency ?? (cpus().length - 1);

        console.log(chalk.bold('\n🔍 Scanning for ready issues...\n'));

        const issues = await tracker.listIssues({
          labels: cfg.requiredLabels,
          state: 'opened',
        });

        if (issues.length === 0) {
          console.log(chalk.gray('  No ready issues found.'));
          return;
        }

        console.log(chalk.gray(`  Found ${issues.length} ready issues`));

        // Build DAG from blocks-<iid> labels
        const blocksForward = new Map<number, number[]>();
        const inDegree = new Map<number, number>();
        const allIds = new Set<number>();

        for (const issue of issues) {
          allIds.add(issue.id);
          inDegree.set(issue.id, 0);
        }

        for (const issue of issues) {
          for (const label of issue.labels) {
            const match = label.match(/^blocks-(\d+)$/);
            if (match) {
              const blocked = parseInt(match[1], 10);
              if (allIds.has(blocked)) {
                const existing = blocksForward.get(issue.id) ?? [];
                existing.push(blocked);
                blocksForward.set(issue.id, existing);
                inDegree.set(blocked, (inDegree.get(blocked) ?? 0) + 1);
              }
            }
          }
        }

        // Kahn's algorithm
        const waves: number[][] = [];
        while (allIds.size > 0) {
          const wave: number[] = [];
          for (const id of allIds) {
            if ((inDegree.get(id) ?? 0) === 0) wave.push(id);
          }
          if (wave.length === 0) {
            logger.warn({ cyclicIds: [...allIds] }, 'cycle detected in DAG');
            waves.push([...allIds]);
            break;
          }
          waves.push(wave);
          for (const id of wave) {
            allIds.delete(id);
            for (const blocked of blocksForward.get(id) ?? []) {
              if (allIds.has(blocked)) {
                inDegree.set(blocked, (inDegree.get(blocked) ?? 0) - 1);
              }
            }
          }
        }

        console.log(chalk.gray(`  Built ${waves.length} wave(s)\n`));

        let totalProcessed = 0;
        for (let w = 0; w < waves.length; w++) {
          const wave = waves[w];
          console.log(chalk.bold(`\n📦 Wave ${w + 1}/${waves.length} (${wave.length} issues, concurrency: ${concurrency})\n`));

          let idx = 0;
          const processNext = async () => {
            const { WorkflowRunner } = await import('../lib/workflows');
            const runner = new WorkflowRunner(tracker);
            while (idx < wave.length) {
              const currentIdx = idx++;
              const iid = wave[currentIdx];
              try {
                const sessionName = tracker.platform === 'github'
                  ? `afk-gh-${iid}`
                  : `afk-gl-${iid}`;
                const result = await runner.run({
                  iid,
                  session: sessionName,
                  targetBranch: process.env.AFK_TARGET_BRANCH || 'main',
                });
                console.log(result.success
                  ? chalk.green(`  ✅ #${iid} completed`)
                  : chalk.yellow(`  ⚠️ #${iid} did not complete`));
                totalProcessed++;
              } catch (err) {
                console.error(chalk.red(`  ❌ #${iid} failed: ${(err as Error).message}`));
                totalProcessed++;
              }
            }
          };

          const workers: Promise<void>[] = [];
          for (let w = 0; w < Math.min(concurrency, wave.length); w++) {
            workers.push(processNext());
          }
          await Promise.all(workers);
        }

        console.log(chalk.green(`\n✅ Scheduler run complete (${totalProcessed} issues processed)\n`));
      } catch (error) {
        handleCommandError(error);
      }
    });
}