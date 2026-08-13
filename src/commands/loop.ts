import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorkflowProviders } from '../application/tracker-provider-factory';
import { LoopRunner } from '../application/modules/loop-runner';
import { getSchedulerConfig } from '../infrastructure/config/manager';
import { loadLoopConfig } from '../application/loop/loop-config';
import { logger, redirectStdioToLog, resolveLogPath } from '../infrastructure/io';
import { handleCommandError, success, info, warning, fail, detail } from '../cli/cli-utils';
import { spawnDetached, waitForProcessPid } from '../infrastructure/process/daemon';
import {
  LOOP_PID_FILE,
  readPid,
  removePidFile,
  ensurePidDirectory,
  isProcessAlive,
} from '../infrastructure/process/pid-file';
import { addLoopStartOptions, parsePositiveInt, type LoopStartOptions } from './loop-options';

const AFK_HOME = path.join(os.homedir(), '.afk');
const STATUS_FILE = path.join(AFK_HOME, 'loop-status.json');

export function registerLoopCommands(program: Command): void {
  const loop = program
    .command('loop')
    .description('Continuous integration loop: poll → implement → QA → done, forever')
    .usage('[command] [options]');

  addLoopStartOptions(loop);
  loop.action(async (options: LoopStartOptions) => {
    try {
      await startLoop(options);
    } catch (error) {
      handleCommandError(error);
    }
  });

  const start = loop
    .command('start')
    .description('Start the loop (foreground by default; -d runs in background)')
    .usage('[options]');
  addLoopStartOptions(start);
  start.action(async (options: LoopStartOptions) => {
    try {
      await startLoop(options);
    } catch (error) {
      handleCommandError(error);
    }
  });

  loop.command('status')
    .description('Show status of the running loop daemon')
    .action(() => {
      try {
        showStatus();
      } catch (error) {
        handleCommandError(error);
      }
    });

  loop.command('stop')
    .description('Stop the running loop daemon (SIGTERM, then SIGKILL after timeout)')
    .option('-t, --timeout <seconds>', 'Max wait for graceful shutdown before SIGKILL', parsePositiveInt)
    .action(async (options: { timeout?: number }) => {
      try {
        await stopLoop(options.timeout ?? 30);
      } catch (error) {
        handleCommandError(error);
      }
    });
}

async function startLoop(options: LoopStartOptions): Promise<void> {
  if (options.daemon && process.env.AFK_LOOP_CHILD !== '1') {
    await startDaemon(process.argv.slice(2));
    return;
  }
  await runLoop(options);
}

async function runLoop(options: LoopStartOptions): Promise<void> {
  if (process.env.AFK_LOOP_CHILD === '1') redirectStdioToLog();

  const schedulerConfig = getSchedulerConfig();
  const loopConfig = loadLoopConfig();
  const maxConcurrent = options.maxConcurrent ?? schedulerConfig.maxConcurrent;
  const pollIntervalMs = (options.pollInterval ?? schedulerConfig.pollInterval) * 1000;
  const statusIntervalMs = (options.statusInterval ?? 30) * 1000;
  const shutdownTimeoutMs = (options.shutdownTimeout ?? 300) * 1000;

  const providers = await createWorkflowProviders(undefined, process.cwd());
  const runner = new LoopRunner(providers, {
    maxConcurrent,
    pollIntervalMs,
    statusIntervalMs,
    shutdownTimeoutMs,
    maxIterations: options.maxIterations,
    ext: options.ext,
    extParams: options.extParam,
    moduleTriggers: loopConfig.moduleTriggers,
    providers,
  });

  printStartup(maxConcurrent, pollIntervalMs, statusIntervalMs, shutdownTimeoutMs, options.maxIterations, loopConfig.moduleTriggers);

  const shutdown = async (signal: string) => {
    warning(`Received ${signal}, draining in-flight work...`);
    try {
      await runner.stop();
    } catch (error) {
      logger.error({ err: error }, 'error during loop shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runner.start();
  success('Loop finished (max-iterations reached)');
  process.exit(0);
}

function printStartup(
  maxConcurrent: number,
  pollIntervalMs: number,
  statusIntervalMs: number,
  shutdownTimeoutMs: number,
  maxIterations: number | undefined,
  moduleTriggers: Record<string, string[]>,
): void {
  console.log(chalk.bold('\n🔁 AFK Loop started\n'));
  console.log(chalk.gray('  Configuration:'));
  console.log(chalk.gray(`    max-concurrent:    ${maxConcurrent}`));
  console.log(chalk.gray(`    poll-interval:     ${pollIntervalMs / 1000}s`));
  console.log(chalk.gray(`    status-interval:   ${statusIntervalMs / 1000}s`));
  console.log(chalk.gray(`    shutdown-timeout:  ${shutdownTimeoutMs / 1000}s`));
  if (maxIterations !== undefined) {
    console.log(chalk.gray(`    max-iterations:    ${maxIterations}`));
  }
  if (Object.keys(moduleTriggers).length > 0) {
    const triggers = Object.entries(moduleTriggers)
      .map(([trigger, modules]) => `${trigger}=${modules.join(',')}`)
      .join('; ');
    console.log(chalk.gray(`    module-triggers:   ${triggers}`));
  }
  console.log(chalk.dim('\nPress Ctrl+C to stop (will drain in-flight work)\n'));
}

async function startDaemon(args: string[]): Promise<void> {
  const existingPid = readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    handleCommandError(
      new Error(`afk loop: already running (pid=${existingPid})`),
      'use `afk loop stop` to stop it first',
    );
    return;
  }
  if (existingPid !== null) removePidFile();

  ensurePidDirectory();
  const childArgs = args.filter(argument => argument !== '--daemon' && argument !== '-d');
  const child = spawnDetached({
    executable: process.execPath,
    script: process.argv[1],
    args: childArgs,
    env: { ...process.env, AFK_LOOP_CHILD: '1' },
  });

  const pid = await waitForProcessPid(readPid, isProcessAlive, 2_000);
  if (pid !== null) {
    success('afk loop daemonized');
    detail(`pid:        ${pid}`);
    detail(`log:        ${resolveLogPath()}`);
    detail(`pid-file:   ${LOOP_PID_FILE}`);
  } else {
    warning(`afk loop: child spawned (pid=${child.pid}) but no pid file appeared`);
    detail(`check log: ${resolveLogPath()}`);
  }
  process.exit(0);
}

function showStatus(): void {
  const pid = readPid();
  if (pid === null) {
    warning('afk loop: not running (no pid file)');
    detail(`expected: ${LOOP_PID_FILE}`);
    return;
  }
  if (!isProcessAlive(pid)) {
    fail(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`);
    removePidFile();
    return;
  }

  success('afk loop: running');
  detail(`pid:        ${pid}`);
  detail(`log:        ${resolveLogPath()}`);
  detail(`status:     ${STATUS_FILE}`);
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) as {
      implement: { active: number; ids: number[] };
      qa: { active: number | null; queue: number[] };
      totals: { completed: number; failed: number };
      startedAt: number;
    };
    detail(`uptime:     ${formatDuration(Date.now() - status.startedAt)}`);
    detail(`implement:  ${status.implement.active} ${JSON.stringify(status.implement.ids)}`);
    detail(`qa:         ${status.qa.active ?? '-'}`);
    detail(`qaQueue:    ${JSON.stringify(status.qa.queue)}`);
    detail(`done:       ${status.totals.completed}`);
    detail(`failed:     ${status.totals.failed}`);
  } catch {
    detail('(status file not yet written — wait for first status tick)');
  }
}

async function stopLoop(timeoutSeconds: number): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    warning('afk loop: not running (no pid file)');
    return;
  }
  if (!isProcessAlive(pid)) {
    fail(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`);
    removePidFile();
    return;
  }

  info(`afk loop: sending SIGTERM to pid=${pid} (waiting up to ${timeoutSeconds}s)...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    handleCommandError(new Error(`failed to send signal: ${(error as Error).message}`));
    return;
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (isProcessAlive(pid)) {
    warning(`afk loop: pid=${pid} did not exit within ${timeoutSeconds}s, sending SIGKILL`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may have exited between the liveness check and SIGKILL.
    }
    return;
  }
  success(`afk loop: pid=${pid} exited`);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
