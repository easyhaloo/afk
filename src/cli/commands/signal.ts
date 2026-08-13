import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { simpleGit } from 'simple-git';
import { getCurrentTimestamp, type Signal } from '../../domain/schemas';
import { writeSignal, readSignal, clearSignal, waitForSignal } from '../../infrastructure/io';
import { handleCommandError, success, info, warning, detail, formatJson } from '../cli-utils';

function parseNonNegativeInt(value: string, _previous: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(`expected a non-negative integer, got '${value}'`);
  }
  return parsed;
}

function parsePositiveInt(value: string, _previous: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got '${value}'`);
  }
  return parsed;
}

function signalSummary(signal: Signal): string {
  switch (signal.type) {
    case 'goal_complete':
    case 'handoff_ready':
      return signal.summary;
    case 'timeout':
    case 'idle':
      return '';
  }
}

export function registerSignalCommands(program: Command): void {
  const signal = program.command('signal').description('Manage structured signal files for workflow communication');

  signal.command('goal-complete')
    .description('Signal that goal execution is complete')
    .requiredOption('-s, --summary <text>', 'Summary of what was accomplished')
    .option('--sha <sha>', 'Git commit SHA (auto-detected if not provided)')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async options => {
      try {
        const sha = options.sha || await getGitSha();
        await writeSignal({ type: 'goal_complete', timestamp: getCurrentTimestamp(), sha, summary: options.summary }, options.dir);
        success('Goal complete signal written');
        detail(`Summary: ${options.summary}`);
        if (sha) detail(`SHA: ${sha}`);
      } catch (error) { handleCommandError(error); }
    });

  signal.command('qa-complete')
    .description('Signal QA completion with a PASS or FAIL result')
    .requiredOption('-r, --result <result>', 'Result: PASS or FAIL')
    .requiredOption('-s, --summary <text>', 'Summary of test results')
    .option('--tests-run <n>', 'Number of tests run', parseNonNegativeInt)
    .option('--tests-passed <n>', 'Number of tests passed', parseNonNegativeInt)
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async options => {
      try {
        if (!['PASS', 'FAIL'].includes(options.result)) throw new Error('Result must be PASS or FAIL');
        if (options.testsPassed !== undefined && options.testsRun !== undefined && options.testsPassed > options.testsRun) {
          throw new Error('tests-passed cannot exceed tests-run');
        }
        await writeSignal({
          type: 'goal_complete',
          timestamp: getCurrentTimestamp(),
          kind: 'qa',
          result: options.result as 'PASS' | 'FAIL',
          summary: options.summary,
          tests_run: options.testsRun,
          tests_passed: options.testsPassed,
        }, options.dir);
        success(`QA completion signal written: ${options.result}`);
        detail(`Summary: ${options.summary}`);
        if (options.testsRun !== undefined) detail(`Tests: ${options.testsPassed ?? 0}/${options.testsRun} passed`);
      } catch (error) { handleCommandError(error); }
    });

  signal.command('handoff-ready')
    .description('Signal that agent is ready for context handoff')
    .requiredOption('-s, --summary <text>', 'Summary of current progress')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async options => {
      try {
        await writeSignal({ type: 'handoff_ready', timestamp: getCurrentTimestamp(), summary: options.summary }, options.dir);
        success('Handoff ready signal written');
        detail(`Summary: ${options.summary}`);
      } catch (error) { handleCommandError(error); }
    });

  signal.command('read')
    .description('Read and display current signal')
    .option('--dir <path>', 'Working directory', process.cwd())
    .option('--json', 'Output as JSON')
    .action(async options => {
      try {
        const signalData = await readSignal(options.dir);
        if (!signalData) { warning('No signal file found'); process.exit(0); }
        if (options.json) {
          formatJson(signalData);
        } else {
          console.log(chalk.bold(`Type: ${signalData.type}`));
          console.log(chalk.gray(`Timestamp: ${signalData.timestamp}`));
          console.log(chalk.gray(`Summary: ${signalSummary(signalData)}`));
          if (signalData.type === 'goal_complete' && signalData.sha) console.log(chalk.gray(`SHA: ${signalData.sha}`));
          if (signalData.type === 'goal_complete' && signalData.kind === 'qa') {
            console.log(chalk.gray(`Result: ${signalData.result}`));
            if (signalData.tests_run !== undefined) {
              console.log(chalk.gray(`Tests: ${signalData.tests_passed ?? 0}/${signalData.tests_run}`));
            }
          }
        }
      } catch (error) { handleCommandError(error); }
    });

  signal.command('wait')
    .description('Wait for a specific signal type')
    .requiredOption('-t, --type <type>', 'Signal type to wait for (goal_complete, handoff_ready, timeout, idle)')
    .option('--timeout <ms>', 'Timeout in milliseconds', '300000')
    .option('--interval <ms>', 'Polling interval in milliseconds', '2000')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async options => {
      try {
        info(`Waiting for signal: ${options.type}...`);
        const signalData = await waitForSignal(options.type, {
          timeout: parsePositiveInt(String(options.timeout)),
          interval: parsePositiveInt(String(options.interval)),
          dir: options.dir,
        });
        success(`Signal received: ${signalData.type}`);
        formatJson(signalData);
      } catch (error) { handleCommandError(error); }
    });

  signal.command('clear')
    .description('Remove signal file')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async options => {
      try { await clearSignal(options.dir); success('Signal file cleared'); }
      catch (error) { handleCommandError(error); }
    });
}

async function getGitSha(): Promise<string | undefined> {
  try {
    const git = simpleGit();
    const sha = await git.revparse(['HEAD']);
    return sha.trim() || undefined;
  } catch {
    return undefined;
  }
}
