import { Command } from 'commander';
import chalk from 'chalk';
import { GitLabClient } from '../lib/gitlab.js';
import { Scheduler } from '../lib/scheduler.js';

export function registerSchedulerCommands(program: Command): void {
  const scheduler = program
    .command('scheduler')
    .description('Event-driven task scheduler with queue management');

  /**
   * start command
   */
  scheduler
    .command('start')
    .description('Start scheduler worker')
    .option('--max-concurrent <n>', 'Max concurrent tasks', '3')
    .option('--redis-host <host>', 'Redis host', 'localhost')
    .option('--redis-port <port>', 'Redis port', '6379')
    .option('--poll-interval <seconds>', 'GitLab polling interval (0 to disable)', '60')
    .action(async (options) => {
      try {
        // PID lock
        const lockDir = process.env.AFK_LOCK_DIR || '/tmp/afk-locks';
        const { promises: fs } = await import('fs');
        await fs.mkdir(lockDir, { recursive: true });
        const lockFile = `${lockDir}/scheduler-${process.env.GITLAB_PROJECT_ID || 'default'}.lock`;
        try {
          const { constants } = await import('fs');
          await fs.open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
        } catch (err: any) {
          if (err.code === 'EEXIST') {
            const oldPid = await fs.readFile(lockFile, 'utf-8').catch(() => '');
            console.error(chalk.red(`❌ Scheduler already running (PID: ${oldPid.trim()}). Remove stale lock: rm ${lockFile}`));
            process.exit(1);
          }
          throw err;
        }
        await fs.writeFile(lockFile, String(process.pid), 'utf-8');

        const gitlab = createGitLabClient();
        const sched = new Scheduler(gitlab, {
          maxConcurrent: parseInt(options.maxConcurrent),
          redisHost: options.redisHost,
          redisPort: parseInt(options.redisPort),
        });

        // Start scheduler
        await sched.start();

        // Optional: poll GitLab periodically
        const pollInterval = parseInt(options.pollInterval);
        if (pollInterval > 0) {
          console.log(chalk.gray(`   Polling GitLab every ${pollInterval}s...`));

          setInterval(async () => {
            try {
              await sched.pollGitLab();
            } catch (error) {
              console.error(chalk.red('Poll error:'), (error as Error).message);
            }
          }, pollInterval * 1000);
        }

        // Keep process alive
        console.log(chalk.dim('\nPress Ctrl+C to stop\n'));

        // Graceful shutdown
        process.on('SIGINT', async () => {
          console.log('\n\nReceived SIGINT, shutting down...');
          await sched.stop();
          await fs.unlink(lockFile).catch(() => {});
          process.exit(0);
        });

        process.on('SIGTERM', async () => {
          console.log('\n\nReceived SIGTERM, shutting down...');
          await sched.stop();
          await fs.unlink(lockFile).catch(() => {});
          process.exit(0);
        });
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * status command
   */
  scheduler
    .command('status')
    .description('Check scheduler status')
    .option('--redis-host <host>', 'Redis host', 'localhost')
    .option('--redis-port <port>', 'Redis port', '6379')
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const sched = new Scheduler(gitlab, {
          redisHost: options.redisHost,
          redisPort: parseInt(options.redisPort),
        });

        const status = await sched.getStatus();

        console.log(chalk.bold('\n📊 Scheduler Status:\n'));
        console.log(chalk.gray('Queue:'));
        console.log(`  Waiting:   ${chalk.yellow(status.queue.waiting)}`);
        console.log(`  Active:    ${chalk.green(status.queue.active)}`);
        console.log(`  Completed: ${chalk.blue(status.queue.completed)}`);
        console.log(`  Failed:    ${chalk.red(status.queue.failed)}`);
        console.log();
        console.log(chalk.gray('Workers:'));
        console.log(`  Active: ${status.workers.active}/${status.workers.total}`);
        console.log();

        if (status.uptime > 0) {
          const uptimeMin = Math.floor(status.uptime / 60000);
          const uptimeHr = Math.floor(uptimeMin / 60);
          console.log(chalk.gray(`Uptime: ${uptimeHr}h ${uptimeMin % 60}m`));
        }

        // Close connection
        await sched.stop();
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
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
    .option('--branch <branch>', 'Base branch', 'main')
    .option('--redis-host <host>', 'Redis host', 'localhost')
    .option('--redis-port <port>', 'Redis port', '6379')
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const sched = new Scheduler(gitlab, {
          redisHost: options.redisHost,
          redisPort: parseInt(options.redisPort),
        });

        const jobId = await sched.enqueue(
          options.iid,
          parseInt(options.priority),
          options.branch
        );

        console.log(chalk.green(`✅ Task enqueued (job ID: ${jobId})`));

        await sched.stop();
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * pause command
   */
  scheduler
    .command('pause')
    .description('Pause task for issue')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .option('--redis-host <host>', 'Redis host', 'localhost')
    .option('--redis-port <port>', 'Redis port', '6379')
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const sched = new Scheduler(gitlab, {
          redisHost: options.redisHost,
          redisPort: parseInt(options.redisPort),
        });

        await sched.pauseTask(options.iid);
        console.log(chalk.green(`✅ Task for issue #${options.iid} paused`));

        await sched.stop();
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * resume command
   */
  scheduler
    .command('resume')
    .description('Resume paused task')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .option('--redis-host <host>', 'Redis host', 'localhost')
    .option('--redis-port <port>', 'Redis port', '6379')
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const sched = new Scheduler(gitlab, {
          redisHost: options.redisHost,
          redisPort: parseInt(options.redisPort),
        });

        await sched.resumeTask(options.iid);
        console.log(chalk.green(`✅ Task for issue #${options.iid} resumed`));

        await sched.stop();
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * poll command
   */
  scheduler
    .command('poll')
    .description('Manually poll GitLab for ready issues')
    .option('--redis-host <host>', 'Redis host', 'localhost')
    .option('--redis-port <port>', 'Redis port', '6379')
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const sched = new Scheduler(gitlab, {
          redisHost: options.redisHost,
          redisPort: parseInt(options.redisPort),
        });

        const enqueued = await sched.pollGitLab();
        console.log(chalk.green(`✅ Polling complete (${enqueued} tasks enqueued)`));

        await sched.stop();
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Create GitLab client from environment variables
 */
function createGitLabClient(): GitLabClient {
  const url = process.env.GITLAB_URL || 'https://gitlab.com';
  const token = process.env.GITLAB_TOKEN;
  const projectId = process.env.GITLAB_PROJECT_ID;

  if (!token) {
    throw new Error('GITLAB_TOKEN environment variable is required');
  }

  if (!projectId) {
    throw new Error('GITLAB_PROJECT_ID environment variable is required');
  }

  return new GitLabClient({ url, token, projectId });
}
