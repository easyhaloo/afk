import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { assembleProviders } from '@afk/runtime/infrastructure/provider/assembly';
import { resolveWorkflowRunRequest } from '@afk/runtime/execution';
import { executionManifestPath } from '@afk/runtime/infrastructure/workspace';
import { LoopRunner } from '@afk/runtime/application/runners/loop-runner';
import { installLoopSignalHandlers } from './loop-signals.js';
import { getSchedulerConfig, getWorkflowConfig } from '@afk/runtime/infrastructure/config/manager';
import { parseWorkItemId } from '@afk/runtime/domain/backlog/index';
import { loadLoopConfig } from '@afk/runtime/application/runners/loop-config';
import { logger, redirectStdioToLog, resolveLogPath } from '@afk/runtime/infrastructure/io/index';
import { handleCommandError, success, info, warning, fail, detail } from '../output.js';
import { spawnDetached, waitForProcessPid } from '@afk/runtime/infrastructure/process/daemon';
import {
  DEFAULT_LOOP_RUN_TAG,
  LEGACY_LOOP_PID_FILE,
  LEGACY_LOOP_STATUS_FILE,
  ensurePidDirectory,
  isProcessAlive,
  legacyLoopPathOverrides,
  liveLoopRunTags,
  loopPidFilePath,
  loopRunTagForWorkItem,
  loopRunsDirectory,
  loopStatusFilePath,
  readPid,
  removePidFile,
  sanitizeLoopRunTag,
} from '@afk/runtime/infrastructure/process/pid-file';
import { addLoopStartOptions, parsePositiveInt, type LoopStartOptions } from './loop-options.js';

export function resolveManagedLoopExecution(
  options: LoopStartOptions,
  moduleTriggers: Record<string, string[]> = {},
): { workItemId: string; manifestPath?: string } {
  if (!options.workItemId || options.backlogId?.length !== 1) {
    throw new Error('managed loop execution requires --work-item-id, exactly one --backlog-id, and optionally an --execution-manifest');
  }
  if (Object.keys(moduleTriggers).length) {
    throw new Error('loop execution does not support module triggers');
  }
  const workItemId = parseWorkItemId(options.workItemId).id;
  // Without a manifest the execution derives one from the work item: the
  // repository it lives in, the ref its body declares, and the branch AFK
  // works on.
  return { workItemId, manifestPath: options.executionManifest };
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

  loop.command('status')
    .description('Show status of the running loop daemon')
    .option('--all', 'Show every loop under the loop runs directory')
    .option('--run-tag <tag>', 'Show the loop filed under this run tag')
    .action((options: { all?: boolean; runTag?: string }) => {
      try { options.all ? showAllLoopStatus() : showStatus(options.runTag); } catch (error) { handleCommandError(error); }
    });

  loop.command('stop').description('Stop the running loop daemon (SIGTERM, then SIGKILL after timeout)')
    .option('-t, --timeout <seconds>', 'Max wait for graceful shutdown before SIGKILL', parsePositiveInt)
    .option('--run-tag <tag>', 'Stop the loop filed under this run tag')
    .action(async (options: { timeout?: number; runTag?: string }) => {
      try { await stopLoop(options.timeout ?? 30, options.runTag); } catch (error) { handleCommandError(error); }
    });
}

async function startLoop(options: LoopStartOptions): Promise<void> {
  const managedExecution = resolveManagedLoopExecution(options, loadLoopConfig().moduleTriggers);
  const runTag = resolveStartRunTag(options, managedExecution.workItemId);
  warnLegacyPathOverrides();
  if (options.daemon && process.env.AFK_LOOP_CHILD !== '1') {
    await startDaemon(runTag);
    return;
  }
  await runLoop(options, runTag);
}

/** The run directory a started loop is filed under: explicit tag, else the work item's. */
function resolveStartRunTag(options: LoopStartOptions, workItemId?: string): string {
  return options.runTag ? sanitizeLoopRunTag(options.runTag) : loopRunTagForWorkItem(workItemId);
}

/**
 * Say once that a path override is ignored.
 *
 * A deployment that used to redirect the status file keeps exporting the
 * variable; silence would leave it wondering why the file stopped changing.
 */
function warnLegacyPathOverrides(): void {
  const ignored = legacyLoopPathOverrides();
  if (ignored.length > 0) {
    warning(`afk loop: ignoring ${ignored.join(', ')} — run state lives under ${loopRunsDirectory()}`);
  }
}

async function runLoop(options: LoopStartOptions, runTag: string): Promise<void> {
  if (process.env.AFK_LOOP_CHILD === '1') redirectStdioToLog();

  const schedulerConfig = getSchedulerConfig();
  const loopConfig = loadLoopConfig();
  const managedExecution = resolveManagedLoopExecution(options, loopConfig.moduleTriggers);
  const pollIntervalMs = (options.pollInterval ?? schedulerConfig.pollInterval) * 1000;
  const statusIntervalMs = (options.statusInterval ?? 30) * 1000;
  const shutdownTimeoutMs = (options.shutdownTimeout ?? 300) * 1000;

  const manifestPath = managedExecution.manifestPath ?? executionManifestPath(managedExecution.workItemId);
  const request = managedExecution.manifestPath || fs.existsSync(manifestPath) ? await resolveWorkflowRunRequest({
    backlogId: managedExecution.workItemId, executionManifestPath: manifestPath,
  }, getWorkflowConfig()) : undefined;
  const { providers } = await assembleProviders({ workItemId: managedExecution.workItemId, cwd: request?.repoRoot ?? process.cwd(),
    ...(request ? { projectId: request.trackerProjectId, projectKey: request.trackerProjectKey, providerHost: request.trackerHost } : {}) });
  const runner = new LoopRunner(providers, {
    pollIntervalMs,
    statusIntervalMs,
    shutdownTimeoutMs,
    maxIterations: options.maxIterations,
    backlogIds: options.backlogId,
    managedExecution,
    targetBranch: getWorkflowConfig().targetBranch,
    template: options.template,
    runTag,
  });

  printStartup(pollIntervalMs, statusIntervalMs, shutdownTimeoutMs, options.maxIterations, options.backlogId, runTag);
  const removeSignals = installLoopSignalHandlers(
    () => runner.stop(),
    signal => warning(`Received ${signal}, draining in-flight work...`),
    error => logger.error({ err: error }, 'error during loop shutdown'),
  );
  try {
    await runner.start();
  } finally {
    removeSignals();
  }
  success('Loop finished (max-iterations reached)');
  process.exit(0);
}

function printStartup(pollIntervalMs: number, statusIntervalMs: number, shutdownTimeoutMs: number, maxIterations: number | undefined, backlogIds: string[] | undefined, runTag: string): void {
  console.log(chalk.bold('\n🔁 AFK Loop started\n'));
  console.log(chalk.gray('  Configuration:'));
  console.log(chalk.gray(`    poll-interval:     ${pollIntervalMs / 1000}s`));
  console.log(chalk.gray(`    status-interval:   ${statusIntervalMs / 1000}s`));
  console.log(chalk.gray(`    shutdown-timeout:  ${shutdownTimeoutMs / 1000}s`));
  if (maxIterations !== undefined) console.log(chalk.gray(`    max-iterations:    ${maxIterations}`));
  if (backlogIds?.length) console.log(chalk.gray(`    backlog-scope:     ${backlogIds.join(', ')}`));
  console.log(chalk.gray(`    run:               ${loopPidFilePath(runTag).replace(/\/loop\.pid$/, '')}`));
  console.log(chalk.dim('\nPress Ctrl+C to stop (will drain in-flight work)\n'));
}

async function startDaemon(runTag: string): Promise<void> {
  const existingPid = readPid(runTag);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    handleCommandError(new Error(`afk loop: already running (pid=${existingPid}, run=${runTag})`), 'use `afk loop stop` to stop it first');
    return;
  }
  if (existingPid !== null) removePidFile(runTag);
  ensurePidDirectory(runTag);
  const child = spawnDetached({
    executable: process.execPath,
    script: process.argv[1],
    args: process.argv.slice(2).filter(argument => argument !== '--daemon' && argument !== '-d'),
    env: { ...process.env, AFK_LOOP_CHILD: '1' },
  });
  const pid = await waitForProcessPid(() => readPid(runTag), isProcessAlive, 2_000);
  if (pid !== null) {
    success('afk loop daemonized');
    detail(`pid:        ${pid}`);
    detail(`log:        ${resolveLogPath()}`);
    detail(`pid-file:   ${loopPidFilePath(runTag)}`);
    detail(`status:     ${loopStatusFilePath(runTag)}`);
  } else {
    warning(`afk loop: child spawned (pid=${child.pid}) but no pid file appeared`);
    detail(`check log: ${resolveLogPath()}`);
  }
  process.exit(0);
}

/**
 * The run a command acts on when the operator names none.
 *
 * `default` when that run is alive, otherwise the only live run. With several
 * live runs there is no single answer, so the command says which ones exist
 * and falls back to `default` instead of guessing.
 */
function resolveCommandRunTag(explicit?: string): string {
  if (explicit) return sanitizeLoopRunTag(explicit);
  const live = liveLoopRunTags();
  if (live.includes(DEFAULT_LOOP_RUN_TAG)) return DEFAULT_LOOP_RUN_TAG;
  if (live.length === 1) return live[0];
  if (live.length > 1) detail(`multiple loops are running: ${live.join(', ')} — use --run-tag, or --all`);
  return DEFAULT_LOOP_RUN_TAG;
}

/**
 * The pid and status files of one run, with the single-release legacy fallback.
 *
 * A loop started by an older CLI wrote `~/.afk/loop.pid` and
 * `~/.afk/loop-status.json`. Reading them keeps `status` and `stop` working
 * across an upgrade; nothing writes them any more.
 */
function loopRunFiles(runTag: string): { pid: string; status: string; legacy: boolean } {
  if (runTag === DEFAULT_LOOP_RUN_TAG && !fs.existsSync(loopPidFilePath(runTag)) && fs.existsSync(LEGACY_LOOP_PID_FILE)) {
    return { pid: LEGACY_LOOP_PID_FILE, status: LEGACY_LOOP_STATUS_FILE, legacy: true };
  }
  return { pid: loopPidFilePath(runTag), status: loopStatusFilePath(runTag), legacy: false };
}

function showStatus(explicitRunTag?: string): void {
  warnLegacyPathOverrides();
  const runTag = resolveCommandRunTag(explicitRunTag);
  const files = loopRunFiles(runTag);
  const pid = readPidFile(files.pid);
  if (pid === null) { warning(`afk loop: not running (${runTag})`); detail(`expected: ${files.pid}`); return; }
  if (!isProcessAlive(pid)) { fail(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`); removePidFile(runTag); return; }
  success(`afk loop: running (${runTag})`);
  detail(`pid:        ${pid}`);
  detail(`log:        ${resolveLogPath()}`);
  detail(`status:     ${files.status}`);
  if (files.legacy) detail('(legacy single-loop layout — restart the loop to move it under loop-runs/)');
  try {
    const status = JSON.parse(fs.readFileSync(files.status, 'utf-8')) as {
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

/**
 * Every loop AFK is running, one line each.
 *
 * A deployment often runs one loop per work item, each with its own pid and
 * status file. The single-loop answer says "not running" for all of them,
 * because it only knows about one pid file — so the directory of loop runs
 * is the thing an operator actually has to look at.
 */
function showAllLoopStatus(): void {
  const root = loopRunsDirectory();
  if (!fs.existsSync(root)) {
    warning(`afk loop: no loop runs directory (${root})`);
    return;
  }
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ tag: entry.name, dir: path.join(root, entry.name) }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
  if (entries.length === 0) {
    warning(`afk loop: no loops under ${root}`);
    return;
  }
  const header = ['LOOP', 'STATE', 'EXEC', 'DONE', 'FAILED', 'LAST ERROR'];
  const widths = [16, 9, 5, 5, 7, 0];
  const rows: string[][] = [];
  for (const entry of entries) {
    const pid = readPidFile(path.join(entry.dir, 'loop.pid'));
    const alive = pid !== null && isProcessAlive(pid);
    const status = readLoopStatus(path.join(entry.dir, 'status.json'));
    const errors = status ? Object.entries(status.lastError ?? {}) : [];
    rows.push([
      entry.tag,
      alive ? 'running' : (pid === null ? 'no pid' : 'stopped'),
      String(status?.execution?.active ?? 0),
      String(status?.totals?.completed ?? 0),
      String(status?.totals?.failed ?? 0),
      errors.length === 0 ? '' : errors.map(([id, reason]) => `${id}: ${reason}`).join('; '),
    ]);
  }
  console.log();
  for (const [index, cell] of header.entries()) {
    process.stdout.write(chalk.bold(cell.padEnd(widths[index])));
  }
  console.log();
  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      process.stdout.write(cell.padEnd(widths[index]).slice(0, widths[index] || undefined));
    }
    console.log();
  }
  console.log();
  if (fs.existsSync(LEGACY_LOOP_PID_FILE)) {
    console.log(chalk.gray(`legacy:     ${LEGACY_LOOP_STATUS_FILE} (kept for one release; restart the loop to move it under loop-runs/)`));
    console.log();
  }
}

/** The pid a loop run recorded, or null when it never started. */
function readPidFile(file: string): number | null {
  try {
    const value = Number(fs.readFileSync(file, 'utf-8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The status snapshot a loop run wrote, or undefined when it wrote none. */
function readLoopStatus(file: string): {
  execution?: { active?: number };
  totals?: { completed?: number; failed?: number };
  lastError?: Record<string, string>;
} | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

async function stopLoop(timeoutSeconds: number, explicitRunTag?: string): Promise<void> {
  const runTag = resolveCommandRunTag(explicitRunTag);
  const files = loopRunFiles(runTag);
  const pid = readPidFile(files.pid);
  if (pid === null) { warning(`afk loop: not running (${runTag})`); return; }
  if (!isProcessAlive(pid)) { fail(`afk loop: pid=${pid} not alive (stale pid file, cleaning up)`); removePidFile(runTag); return; }
  info(`afk loop: sending SIGTERM to pid=${pid} (run=${runTag}, waiting up to ${timeoutSeconds}s)...`);
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
