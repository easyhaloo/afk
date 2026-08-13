import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProviderBundle } from '../lib/client-factory';
import { LoopRunner } from '../lib/modules/loop-runner';
import { getSchedulerConfig } from '../lib/core/config/manager';
import { handleCommandError, success, info, warning, fail, detail } from '../lib/cli-utils';
import { logger, redirectStdioToLog, resolveLogPath } from '../lib/io';
import { addLoopStartOptions, type LoopStartOptions, parsePositiveInt } from './loop-options';

interface LoopConfig {
  moduleTriggers: Record<string, string[]>;
}

export function loadLoopConfig(): LoopConfig {
  const configPath = path.join(process.cwd(), '.afk', 'config.yml');
  const result: LoopConfig = { moduleTriggers: {} };

  try {
    if (!fs.existsSync(configPath)) return result;

    const raw = fs.readFileSync(configPath, 'utf-8');
    const lines = raw.split('\n');

    let inTriggers = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'module_triggers:') { inTriggers = true; continue; }
      if (inTriggers) {
        const colon = trimmed.lastIndexOf(':');
        if (colon < 0) { inTriggers = false; continue; }
        const trigger = trimmed.slice(0, colon).trim();
        const value = trimmed.slice(colon + 1).trim();
        if (!trigger) { inTriggers = false; continue; }
        const listMatch = value.match(/^\[([^\]]*)\]$/);
        if (listMatch) {
          result.moduleTriggers[trigger] = listMatch[1].split(',').map(item => item.trim()).filter(Boolean);
        }
      }
    }
  } catch (error) {
    logger.warn({ err: error, path: configPath }, 'failed to load loop config');
  }

  return result;
}

const AFK_HOME = path.join(os.homedir(), '.afk');
const PID_FILE = path.join(AFK_HOME, 'loop.pid');
const STATUS_FILE = path.join(AFK_HOME, 'loop-status.json');

const startAction = (options: LoopStartOptions): Promise<void> => {
  if (options.daemon && process.env.AFK_LOOP_CHILD !== '1') {
    return startDaemon(process.argv.slice(2));
  }
  return runForeground(options);
};

export function registerLoopCommands(program: Command): void {
  const loop = program
    .command('loop')
    .description('Continuous integration loop: poll → implement → QA → done, forever')
    .usage('[command] [options]');

  addLoopStartOptions(loop);
  loop.action(async (options: LoopStartOptions) => {
    try {
      await startAction(options);
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
      await startAction(options);
    } catch (error) {
      handleCommandError(error);
    }
  });

  loop
    .command('status')
    .description('Show status of the running loop daemon')
    .action(async () => {
      try {
        showStatus();
      } catch (error) {
        handleCommandError(error);
      }
    });

  loop
    .command('stop')
    .description('Stop the running loop daemon (SIGTERM, then SIGKILL after timeout)')
    .option('-t, --timeout <seconds>', 'Max wait for graceful shutdown before SIGKILL', parsePositiveInt)
    .action(async (options: { timeout?: number }) => {
      try {
        await stopDaemon({ timeoutSeconds: options.timeout ?? 30 });
      } catch (error) {
        handleCommandError(error);
      }
    });
}

async function runForeground(options: LoopStartOptions): Promise<void> {
  if (process.env.AFK_LOOP_CHILD === '1') redirectStdioToLog();

  const schedulerConfig = getSchedulerConfig();
  const loopConfig = loadLoopConfig();

  const maxConcurrent = options.maxConcurrent ?? schedulerConfig.maxConcurrent;
  const pollInterval = (options.pollInterval ?? schedulerConfig.pollInterval) * 1000;
  const statusInterval = (options.statusInterval ?? 30) * 1000;
  const shutdownTimeout = (options.shutdownTimeout ?? 300) * 1000;
  const maxIterations = options.maxIterations;

  const providers = await createProviderBundle(undefined, process.cwd());
  const runner = new LoopRunner(providers, {
    maxConcurrent,
    pollIntervalMs: pollInterval,
    statusIntervalMs: statusInterval,
    shutdownTimeoutMs: shutdownTimeout,
    maxIterations,
    ext: options.ext,
    extParams: options.extParam,
    moduleTriggers: loopConfig.moduleTriggers,
    providers,
  });

  console.log(chalk.bold('\n🔁 AFK Loop started\n'));
  console.log(chalk.gray('  Configuration:'));
  console.log(chalk.gray(`    max-concurrent:    ${maxConcurrent}`));
  console.log(chalk.gray(`    poll-interval:     ${pollInterval / 1000}s`));
  console.log(chalk.gray(`    status-interval:   ${statusInterval / 1000}s`));
  console.log(chalk.gray(`    shutdown-timeout:  ${shutdownTimeout / 1000}s`));
  if (maxIterations !== undefined) console.log(chalk.gray(`    max-iterations:    ${maxIterations}`));

  const moduleTriggers = loopConfig.moduleTriggers;
  if (Object.keys(moduleTriggers).length > 0) {
    const triggers = Object.entries(moduleTriggers)
      .map(([trigger, modules]) => `${trigger}=${modules.join(',')}`)
      .join('; ');
    console.log(chalk.gray(`    module-triggers:   ${triggers}`));
  }
  console.log(chalk.dim('\nPress Ctrl+C to stop (will drain in-flight work)\n'));

  const shutdown = async (signal: string) => {
    warning(`Received ${signal}, draining in-flight work...`);
    try {
      await runner.stop();
    } catch (error) {
      logger.error({ err: error }, 'error during stop');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runner.start();
  success('Loop finished (max-iterations reached)');
  process.exit(0);
}

async function startDaemon(args: string[]): Promise<void> {
  const existing = readPid();
  if (existing !== null && isProcessAlive(existing)) {
    handleCommandError(
      new Error(`afk loop: already running (pid=${existing})`),
      'use `afk loop stop` to stop it first',
    );
  }
  if (existing !== null) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  const childArgs = args.filter(argument => argument !== '--daemon' && argument !== '-d');

  const child = spawn(process.execPath, [process.argv[1], ...childArgs], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, AFK_LOOP_CHILD: '1' },
  });
  child.unref();

  const pid = await waitForChildPid(2000);
  if (pid !== null) {
    success('afk loop daemonized');
    detail(`pid:        ${pid}`);
    detail(`log:        ${resolveLogPath()}`);
    console.log('');
    console.log(chalk.dim('  Useful commands:'));
    console.log(`    ${chalk.cyan('afk loop status')}    ${chalk.gray('# show running state')}`);
    console.log(`    ${chalk.cyan('afk loop stop')}      ${chalk.gray('# gracefully stop')}`);
    console.log(`    ${chalk.cyan('tail -f')} ${resolveLogPath()}  ${chalk.gray('# stream events')}`);
  } else {
    warning(`afk loop: child spawned (pid=${child.pid}) but no pid file appeared`);
    detail(`check log: ${resolveLogPath()}`);
  }
  process.exit(0);
}

async function waitForChildPid(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid();
    if (pid !== null && isProcessAlive(pid)) return pid;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  return null;
}

function showStatus(): void {
  const pid = readPid();
  if (pid === null) {
    warning('afk loop: not running (no pid file)');
    detail(`expected: ${PID_FILE}`);
    return;
  }
  if (!isProcessAlive(pid)) {
    fail(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`);
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }
  success('afk loop: running');
  detail(`pid:        ${pid}`);
  detail(`log:        ${resolveLogPath()}`);
  detail(`status:     ${STATUS_FILE}`);
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    const status = JSON.parse(raw) as {
      implement: { active: number; ids: number[] };
      qa: { active: number | null; queue: number[] };
      totals: { completed: number; failed: number; started: number };
      startedAt: number;
      lastUpdateAt: number;
    };
    const uptime = formatDuration(Date.now() - status.startedAt);
    detail(`uptime:     ${uptime}`);
    detail(`implement:  ${status.implement.active} ${JSON.stringify(status.implement.ids)}`);
    detail(`qa:         ${status.qa.active ?? '-'}`);
    detail(`qaQueue:    ${JSON.stringify(status.qa.queue)}`);
    detail(`completed:  ${status.totals.completed}`);
    detail(`failed:     ${status.totals.failed}`);
    detail(`started:    ${status.totals.started}`);
    detail(`last-update: ${new Date(status.lastUpdateAt).toISOString()}`);
  } catch {
    detail('status file not available yet');
  }
}

async function stopDaemon(options: { timeoutSeconds: number }): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    warning('afk loop: not running');
    return;
  }
  if (!isProcessAlive(pid)) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    warning('afk loop: stale pid file removed');
    return;
  }

  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  if (isProcessAlive(pid)) {
    process.kill(pid, 'SIGKILL');
    fail(`afk loop: force-killed pid=${pid}`);
    return;
  }
  success('afk loop stopped');
}

function readPid(): number | null {
  try {
    const value = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}
