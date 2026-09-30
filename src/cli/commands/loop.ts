import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorkflowProviders } from '../../infrastructure/provider/tracker-provider-factory.js';
import { LoopRunner } from '../../application/modules/loop-runner.js';
import { getSchedulerConfig } from '../../infrastructure/config/manager.js';
import { parseWorkItemId } from '../../domain/backlog/index.js';
import { loadLoopConfig } from '../../application/loop/loop-config.js';
import { logger, redirectStdioToLog, resolveLogPath } from '../../infrastructure/io/index.js';
import { handleCommandError, success, info, warning, fail, detail } from '../cli-utils.js';
import { spawnDetached, waitForProcessPid } from '../../infrastructure/process/daemon.js';
import {
  LOOP_PID_FILE,
  readPid,
  removePidFile,
  ensurePidDirectory,
  isProcessAlive,
} from '../../infrastructure/process/pid-file.js';
import { addLoopStartOptions, parsePositiveInt, type LoopStartOptions } from './loop-options.js';

const AFK_HOME = path.join(os.homedir(), '.afk');
const STATUS_FILE = path.join(AFK_HOME, 'loop-status.json');

export function resolveManagedLoopExecution(
  options: LoopStartOptions,
  moduleTriggers: Record<string, string[]> = {},
): { workItemId: string; manifestPath: string } {
  if (!options.workItemId || !options.executionManifest || options.backlogId?.length !== 1) {
    throw new Error('managed loop execution requires --work-item-id, --execution-manifest, and exactly one --backlog-id');
  }
  if (Object.keys(moduleTriggers).length) {
    throw new Error('loop execution does not support module triggers');
  }
  return { workItemId: parseWorkItemId(options.workItemId).id, manifestPath: options.executionManifest };
}

export function registerLoopCommands(program: Command): void {
  const loop = program.command('loop').description('Continuous manifest-bound work item execution').usage('[command] [options]');
  addLoopStartOptions(loop);
  loop.action(async (options: LoopStartOptions) => {
    try { await startLoop(options); } catch (error) { handleCommandError(error); }
  });

  const start = loop.command('start').description('Start the loop (foreground by default; -d runs in background)').usage('[options]');
  addLoopStartOptions(start);
  start.action(async (options: LoopStartOptions) => {
    try { await startLoop(options); } catch (error) { handleCommandError(error); }
  });

  loop.command('status').description('Show status of the running loop daemon').action(() => {
    try { showStatus(); } catch (error) { handleCommandError(error); }
  });

  loop.command('stop').description('Stop the running loop daemon (SIGTERM, then SIGKILL after timeout)')
    .option('-t, --timeout <seconds>', 'Max wait for graceful shutdown before SIGKILL', parsePositiveInt)
    .action(async (options: { timeout?: number }) => {
      try { await stopLoop(options.timeout ?? 30); } catch (error) { handleCommandError(error); }
    });
}

async function startLoop(options: LoopStartOptions): Promise<void> {
  resolveManagedLoopExecution(options, loadLoopConfig().moduleTriggers);
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
  const managedExecution = resolveManagedLoopExecution(options, loopConfig.moduleTriggers);
  const pollIntervalMs = (options.pollInterval ?? schedulerConfig.pollInterval) * 1000;
  const statusIntervalMs = (options.statusInterval ?? 30) * 1000;
  const shutdownTimeoutMs = (options.shutdownTimeout ?? 300) * 1000;

  const providers = await createWorkflowProviders(undefined, process.cwd());
  const runner = new LoopRunner(providers, {
    pollIntervalMs,
    statusIntervalMs,
    shutdownTimeoutMs,
    maxIterations: options.maxIterations,
    backlogIds: options.backlogId,
    managedExecution,
    template: options.template,
  });

  printStartup(pollIntervalMs, statusIntervalMs, shutdownTimeoutMs, options.maxIterations, options.backlogId);
  const shutdown = async (signal: string) => {
    warning(`Received ${signal}, draining in-flight work...`);
    try { await runner.stop(); } catch (error) { logger.error({ err: error }, 'error during loop shutdown'); }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await runner.start();
  success('Loop finished (max-iterations reached)');
  process.exit(0);
}

function printStartup(pollIntervalMs: number, statusIntervalMs: number, shutdownTimeoutMs: number, maxIterations: number | undefined, backlogIds?: string[]): void {
  console.log(chalk.bold('\n🔁 AFK Loop started\n'));
  console.log(chalk.gray('  Configuration:'));
  console.log(chalk.gray(`    poll-interval:     ${pollIntervalMs / 1000}s`));
  console.log(chalk.gray(`    status-interval:   ${statusIntervalMs / 1000}s`));
  console.log(chalk.gray(`    shutdown-timeout:  ${shutdownTimeoutMs / 1000}s`));
  if (maxIterations !== undefined) console.log(chalk.gray(`    max-iterations:    ${maxIterations}`));
  if (backlogIds?.length) console.log(chalk.gray(`    backlog-scope:     ${backlogIds.join(', ')}`));
  console.log(chalk.dim('\nPress Ctrl+C to stop (will drain in-flight work)\n'));
}

async function startDaemon(args: string[]): Promise<void> {
  const existingPid = readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    handleCommandError(new Error(`afk loop: already running (pid=${existingPid})`), 'use `afk loop stop` to stop it first');
    return;
  }
  if (existingPid !== null) removePidFile();
  ensurePidDirectory();
  const child = spawnDetached({
    executable: process.execPath,
    script: process.argv[1],
    args: args.filter(argument => argument !== '--daemon' && argument !== '-d'),
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
  if (pid === null) { warning('afk loop: not running (no pid file)'); detail(`expected: ${LOOP_PID_FILE}`); return; }
  if (!isProcessAlive(pid)) { fail(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`); removePidFile(); return; }
  success('afk loop: running');
  detail(`pid:        ${pid}`);
  detail(`log:        ${resolveLogPath()}`);
  detail(`status:     ${STATUS_FILE}`);
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) as {
      execution: { active: number; ids: string[] };
      totals: { completed: number; failed: number };
      startedAt: number;
    };
    detail(`uptime:     ${formatDuration(Date.now() - status.startedAt)}`);
    detail(`execution:  ${status.execution.active} ${JSON.stringify(status.execution.ids)}`);
    detail(`done:       ${status.totals.completed}`);
    detail(`failed:     ${status.totals.failed}`);
  } catch { detail('(status file not yet written — wait for first status tick)'); }
}

async function stopLoop(timeoutSeconds: number): Promise<void> {
  const pid = readPid();
  if (pid === null) { warning('afk loop: not running (no pid file)'); return; }
  if (!isProcessAlive(pid)) { fail(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`); removePidFile(); return; }
  info(`afk loop: sending SIGTERM to pid=${pid} (waiting up to ${timeoutSeconds}s)...`);
  try { process.kill(pid, 'SIGTERM'); } catch (error) { handleCommandError(new Error(`failed to send signal: ${(error as Error).message}`)); return; }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline && isProcessAlive(pid)) await new Promise(resolve => setTimeout(resolve, 200));
  if (isProcessAlive(pid)) {
    warning(`afk loop: pid=${pid} did not exit within ${timeoutSeconds}s, sending SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
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
