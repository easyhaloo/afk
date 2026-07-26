import { Command } from 'commander';
import chalk from 'chalk';
import { simpleGit } from 'simple-git';
import { getCurrentTimestamp } from '../lib/schemas.js';
import { writeSignal, readSignal, clearSignal, waitForSignal } from '../lib/io.js';

export function registerSignalCommands(program: Command): void {
  const signal = program
    .command('signal')
    .description('Manage structured signal files for workflow communication');

  /**
   * goal-complete command
   */
  signal
    .command('goal-complete')
    .description('Signal that goal execution is complete')
    .requiredOption('-s, --summary <text>', 'Summary of what was accomplished')
    .option('--sha <sha>', 'Git commit SHA (auto-detected if not provided)')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async (options) => {
      try {
        const sha = options.sha || await getGitSha();

        await writeSignal({
          type: 'goal_complete',
          timestamp: getCurrentTimestamp(),
          sha,
          summary: options.summary,
        }, options.dir);

        console.log(chalk.green('✓ Goal complete signal written'));
        console.log(chalk.gray(`  Summary: ${options.summary}`));
        if (sha) console.log(chalk.gray(`  SHA: ${sha}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * ac-result command
   */
  signal
    .command('ac-result')
    .description('Signal acceptance criteria check result')
    .requiredOption('-r, --result <result>', 'Result: PASS or FAIL')
    .requiredOption('-s, --summary <text>', 'Summary of test results')
    .option('--tests-run <n>', 'Number of tests run', parseInt)
    .option('--tests-passed <n>', 'Number of tests passed', parseInt)
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async (options) => {
      try {
        if (!['PASS', 'FAIL'].includes(options.result)) {
          throw new Error('Result must be PASS or FAIL');
        }

        await writeSignal({
          type: 'ac_result',
          timestamp: getCurrentTimestamp(),
          result: options.result as 'PASS' | 'FAIL',
          summary: options.summary,
          tests_run: options.testsRun,
          tests_passed: options.testsPassed,
        }, options.dir);

        const emoji = options.result === 'PASS' ? '✓' : '✗';
        const color = options.result === 'PASS' ? chalk.green : chalk.red;

        console.log(color(`${emoji} AC result signal written: ${options.result}`));
        console.log(chalk.gray(`  Summary: ${options.summary}`));
        if (options.testsRun) {
          console.log(chalk.gray(`  Tests: ${options.testsPassed || 0}/${options.testsRun} passed`));
        }
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * handoff-ready command
   */
  signal
    .command('handoff-ready')
    .description('Signal that agent is ready for context handoff')
    .requiredOption('-s, --summary <text>', 'Summary of current progress')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async (options) => {
      try {
        await writeSignal({
          type: 'handoff_ready',
          timestamp: getCurrentTimestamp(),
          summary: options.summary,
        }, options.dir);

        console.log(chalk.green('✓ Handoff ready signal written'));
        console.log(chalk.gray(`  Summary: ${options.summary}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * read command
   */
  signal
    .command('read')
    .description('Read and display current signal')
    .option('--dir <path>', 'Working directory', process.cwd())
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const signalData = await readSignal(options.dir);

        if (!signalData) {
          console.log(chalk.yellow('No signal file found'));
          process.exit(0);
        }

        if (options.json) {
          console.log(JSON.stringify(signalData, null, 2));
        } else {
          console.log(chalk.bold(`Type: ${signalData.type}`));
          console.log(chalk.gray(`Timestamp: ${signalData.timestamp}`));
          console.log(chalk.gray(`Summary: ${(signalData as any).summary ?? ''}`));

          if (signalData.type === 'goal_complete' && signalData.sha) {
            console.log(chalk.gray(`SHA: ${signalData.sha}`));
          }

          if (signalData.type === 'ac_result') {
            console.log(chalk.gray(`Result: ${signalData.result}`));
            if (signalData.tests_run) {
              console.log(chalk.gray(`Tests: ${signalData.tests_passed || 0}/${signalData.tests_run}`));
            }
          }
        }
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * wait command
   */
  signal
    .command('wait')
    .description('Wait for a specific signal type')
    .requiredOption('-t, --type <type>', 'Signal type to wait for')
    .option('--timeout <ms>', 'Timeout in milliseconds', '300000')
    .option('--interval <ms>', 'Polling interval in milliseconds', '2000')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async (options) => {
      try {
        console.log(chalk.blue(`Waiting for signal: ${options.type}...`));

        const signalData = await waitForSignal(options.type, {
          timeout: parseInt(options.timeout),
          interval: parseInt(options.interval),
          dir: options.dir,
        });

        console.log(chalk.green(`✓ Signal received: ${signalData.type}`));
        console.log(JSON.stringify(signalData, null, 2));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * clear command
   */
  signal
    .command('clear')
    .description('Remove signal file')
    .option('--dir <path>', 'Working directory', process.cwd())
    .action(async (options) => {
      try {
        await clearSignal(options.dir);
        console.log(chalk.green('✓ Signal file cleared'));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Helper: Get current git SHA
 */
async function getGitSha(): Promise<string | undefined> {
  try {
    const git = simpleGit();
    const sha = await git.revparse(['HEAD']);
    return sha.trim() || undefined;
  } catch {
    return undefined;
  }
}
