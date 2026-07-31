import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTrackerClient } from '../lib/client-factory';
import { LoopRunner } from '../lib/loop-runner';
import { getSchedulerConfig } from '../lib/config-manager';
import { handleCommandError } from '../lib/cli-utils';
import { logger, redirectStdioToLog, resolveLogPath } from '../lib/io';

// ── File locations (single source of truth) ─────────────────────────────────

const AFK_HOME = path.join(os.homedir(), '.afk');
const PID_FILE = path.join(AFK_HOME, 'loop.pid');
const STATUS_FILE = path.join(AFK_HOME, 'loop-status.json');
// Log file is the shared day-rotated file from the logger (resolveLogPath()).

/**
 * `afk loop` — single-command continuous-integration worker.
 *
 * Polls `stage::ready-for-issues` (and other `mode::afk` issues), runs
 * WorkflowRunner (implement → MR → `stage::qa`), then immediately hands off
 * to QARunner (verify on merged code → `stage::done` or `mode::hitl`).
 * Loops forever until SIGINT/SIGTERM.
 *
 * Concurrency model: N implement chains in parallel (--max-concurrent, default
 * 3), QA runs serially (1 at a time) to avoid worktree/tmux thrash.
 *
 * Failure handling: a QA failure (`mode::hitl`) is logged and the issue is
 * skipped — the loop continues with the next issue. Implement failures are
 * handled the same way (WorkflowRunner itself labels the issue `mode::hitl`).
 *
 * Subcommands:
 *   afk loop start [--daemon] [opts]   start the loop (foreground or detached)
 *   afk loop status                    show running daemon's state
 *   afk loop stop [--timeout N]        gracefully stop the daemon
 *
 * `afk loop start --daemon` returns immediately and runs the loop as a
 * background process. All its output (banners, status lines, diagnostics)
 * goes to the unified day-rotated log file `~/.afk/logs/afk-YYYY-MM-DD.log`
 * (the daemon child calls redirectStdioToLog()).
 * Replaces the need to run `afk scheduler start` + `afk qa start` in parallel.
 */
/** Options shared by `afk loop` and `afk loop start`. */
const START_OPTIONS = [
  ['-d, --daemon', 'Run as background daemon (returns immediately, logs to file)'],
  ['-n, --max-concurrent <n>', 'Max parallel implement chains'],
  ['-p, --poll-interval <seconds>', 'Tracker poll interval'],
  ['-i, --status-interval <seconds>', 'Status file write interval'],
  ['-t, --shutdown-timeout <seconds>', 'Max wait for in-flight on SIGTERM'],
  ['-m, --max-iterations <n>', 'Stop after N successful completions (testing)'],
] as const;

function startAction(options: Record<string, unknown>): Promise<void> {
  if (options.daemon) {
    return startDaemon(process.argv.slice(2));
  }
  return runForeground(options);
}

export function registerLoopCommands(program: Command): void {
  // `afk loop` with no subcommand behaves exactly like `afk loop start`
  const loop = program
    .command('loop')
    .description('Continuous integration loop: poll → implement → QA → done, forever')
    .usage('[command] [options]');

  // Only pass a value parser to options that take a value — commander 12
  // calls the parser for boolean flags too, and parseInt(undefined) → NaN
  // (falsy), which would silently disable -d/--daemon.
  const addOptions = (cmd: Command) => {
    for (const [flags, description] of START_OPTIONS) {
      if (flags.includes('<')) {
        cmd.option(flags, description, parseInt);
      } else {
        cmd.option(flags, description);
      }
    }
  };

  addOptions(loop);
  loop.action(async (options) => {
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
  addOptions(start);
  start.action(async (options) => {
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
    .option('-t, --timeout <seconds>', 'Max wait for graceful shutdown before SIGKILL', parseInt)
    .action(async (options) => {
      try {
        await stopDaemon({ timeoutSeconds: options.timeout ?? 30 });
      } catch (error) {
        handleCommandError(error);
      }
    });
}

// ── foreground runner ───────────────────────────────────────────────────────

async function runForeground(options: Record<string, unknown>): Promise<void> {
  // Daemon child (AFK_LOOP_CHILD=1, stdio ignored): swap console + stdout
  // onto the day log BEFORE any output, so banners and status lines land in
  // the same unified log file as diagnostics. Foreground runs (TTY or piped)
  // keep their normal stdout/stderr.
  if (process.env.AFK_LOOP_CHILD === '1') redirectStdioToLog();

  const cfg = getSchedulerConfig();

  const maxConcurrent = (options.maxConcurrent as number | undefined) ?? cfg.maxConcurrent;
  const pollInterval = ((options.pollInterval as number | undefined) ?? cfg.pollInterval) * 1000;
  const statusInterval = ((options.statusInterval as number | undefined) ?? 30) * 1000;
  const shutdownTimeout = ((options.shutdownTimeout as number | undefined) ?? 300) * 1000;
  const maxIterations = options.maxIterations as number | undefined;

  const tracker = await createTrackerClient();
  const runner = new LoopRunner(tracker, {
    maxConcurrent,
    pollIntervalMs: pollInterval,
    statusIntervalMs: statusInterval,
    requiredLabels: cfg.requiredLabels,
    excludeLabels: cfg.excludeLabels,
    shutdownTimeoutMs: shutdownTimeout,
    maxIterations,
  });

  console.log(chalk.bold('\n🔁 AFK Loop started\n'));
  console.log(chalk.gray('  Configuration:'));
  console.log(chalk.gray(`    max-concurrent:    ${maxConcurrent}`));
  console.log(chalk.gray(`    poll-interval:     ${pollInterval / 1000}s`));
  console.log(chalk.gray(`    status-interval:   ${statusInterval / 1000}s`));
  console.log(chalk.gray(`    shutdown-timeout:  ${shutdownTimeout / 1000}s`));
  console.log(chalk.gray(`    required-labels:   ${cfg.requiredLabels.join(', ')}`));
  console.log(chalk.gray(`    exclude-labels:    ${cfg.excludeLabels.join(', ')}`));
  if (maxIterations !== undefined) {
    console.log(chalk.gray(`    max-iterations:    ${maxIterations}`));
  }
  console.log(chalk.dim('\nPress Ctrl+C to stop (will drain in-flight work)\n'));

  // Register signal handlers BEFORE start() so we catch signals during
  // the first poll and during drain.
  const shutdown = async (signal: string) => {
    console.log(chalk.yellow(`\n\nReceived ${signal}, draining in-flight work...`));
    try {
      await runner.stop();
    } catch (err) {
      logger.error({ err }, 'error during stop');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runner.start();
  // start() resolves when --max-iterations is reached
  console.log(chalk.green('\n✅ Loop finished (max-iterations reached)\n'));
  process.exit(0);
}

// ── daemon mode ─────────────────────────────────────────────────────────────

/**
 * Re-exec the same CLI without `--daemon`, with stdio redirected to the log
 * file and a new session. Parent waits briefly for the child to write its
 * pid file, then exits.
 */
async function startDaemon(args: string[]): Promise<void> {
  // 1. Refuse to start if another instance is already running.
  const existing = readPid();
  if (existing !== null && isProcessAlive(existing)) {
    console.error(chalk.red(`afk loop: already running (pid=${existing})`));
    console.error(chalk.dim('  use `afk loop stop` to stop it first'));
    process.exit(1);
  }
  if (existing !== null) {
    // Stale pid file from a previous crash
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  // 2. Make sure the pid dir exists before spawn.
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });

  // 3. Strip --daemon/-d from the child args (it's a parent-side signal only).
  const childArgs = args.filter(a => a !== '--daemon' && a !== '-d');

  // 4. Spawn detached. `detached: true` puts the child in its own session so
  //    it survives terminal disconnect (no SIGHUP). `unref()` lets the parent
  //    exit without waiting for the child. stdio is ignored: the child swaps
  //    its console/stdout onto the day-rotated log file itself
  //    (redirectStdioToLog in runForeground) so ALL its output — banners,
  //    status lines, diagnostics — lands in the unified log.
  const child = spawn(process.execPath, [process.argv[1], ...childArgs], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, AFK_LOOP_CHILD: '1' },
  });
  child.unref();

  // 6. Wait briefly for the child to write its pid file. LoopRunner writes
  //    it inside start() — typically <100ms after fork, but TrackerClient
  //    construction can be slow on first run.
  const pid = await waitForChildPid(2000);

  if (pid !== null) {
    console.log(chalk.green('✓ afk loop daemonized'));
    console.log(`  pid:        ${pid}`);
    console.log(`  log:        ${resolveLogPath()}`);
    console.log('');
    console.log(chalk.dim('  Useful commands:'));
    console.log(`    ${chalk.cyan('afk loop status')}    ${chalk.gray('# show running state')}`);
    console.log(`    ${chalk.cyan('afk loop stop')}      ${chalk.gray('# gracefully stop')}`);
    console.log(`    ${chalk.cyan('tail -f')} ${resolveLogPath()}  ${chalk.gray('# stream events')}`);
  } else {
    console.log(chalk.yellow(`afk loop: child spawned (pid=${child.pid}) but no pid file appeared`));
    console.log(`  check log: ${resolveLogPath()}`);
  }
  process.exit(0);
}

async function waitForChildPid(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid();
    if (pid !== null && isProcessAlive(pid)) return pid;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

// ── status subcommand ───────────────────────────────────────────────────────

function showStatus(): void {
  const pid = readPid();
  if (pid === null) {
    console.log(chalk.yellow('afk loop: not running (no pid file)'));
    console.log(chalk.dim(`  expected: ${PID_FILE}`));
    return;
  }
  if (!isProcessAlive(pid)) {
    console.log(chalk.red(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`));
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }
  console.log(chalk.green(`afk loop: running`));
  console.log(`  pid:        ${pid}`);
  console.log(`  log:        ${resolveLogPath()}`);
  console.log(`  status:     ${STATUS_FILE}`);
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
    console.log(`  uptime:     ${uptime}`);
    console.log(`  implement:  ${status.implement.active} ${JSON.stringify(status.implement.ids)}`);
    console.log(`  qa:         ${status.qa.active ?? '-'}`);
    console.log(`  qaQueue:    ${JSON.stringify(status.qa.queue)}`);
    console.log(`  done:       ${status.totals.completed}`);
    console.log(`  failed:     ${status.totals.failed}`);
  } catch {
    console.log(chalk.dim('  (status file not yet written — wait for first status tick)'));
  }
}

// ── stop subcommand ─────────────────────────────────────────────────────────

async function stopDaemon(opts: { timeoutSeconds: number }): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log(chalk.yellow('afk loop: not running (no pid file)'));
    return;
  }
  if (!isProcessAlive(pid)) {
    console.log(chalk.red(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`));
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }
  console.log(chalk.cyan(`afk loop: sending SIGTERM to pid=${pid} (waiting up to ${opts.timeoutSeconds}s)...`));
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(chalk.red(`failed to send signal: ${(err as Error).message}`));
    process.exit(1);
  }
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      console.log(chalk.green(`afk loop: pid=${pid} exited`));
      // LoopRunner deletes the pid file in its own stop() — nothing to do here.
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(chalk.yellow(`afk loop: pid=${pid} did not exit within ${opts.timeoutSeconds}s, sending SIGKILL`));
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

// ── pid / process helpers ───────────────────────────────────────────────────

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but not ours; still alive
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
