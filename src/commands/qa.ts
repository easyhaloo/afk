import { Command } from 'commander';
import chalk from 'chalk';
import { createTrackerClient } from '../lib/client-factory';
import { QARunner } from '../lib/qa-runner';
import { handleCommandError } from '../lib/cli-utils';
import { logger } from '../lib/io';

export function registerQACommands(program: Command): void {
  const qa = program
    .command('qa')
    .description('QA verification: verify AC on merged code')
    .action(() => {
      program.commands.find(c => c.name() === 'qa')?.outputHelp();
    });

  /**
   * qa run — single issue or PRD-level QA
   */
  qa
    .command('run')
    .description('Run QA verification for an issue or all issues under a PRD')
    .option('--iid <iid>', 'Issue IID (single issue QA)', parseInt)
    .option('--prd-iid <prdIid>', 'PRD issue IID (batch QA for all sub-issues)', parseInt)
    .action(async (options) => {
      try {
        if (!options.iid && !options.prdIid) {
          console.error(chalk.red('❌ Either --iid or --prd-iid is required'));
          process.exit(1);
        }

        const tracker = await createTrackerClient();
        const runner = new QARunner(tracker);

        if (options.iid) {
          console.log(chalk.cyan(`\n🔍 Running QA for issue #${options.iid}...\n`));
          const result = await runner.process(options.iid);

          if (result.success) {
            console.log(chalk.green('\n✅ QA passed!'));
            if (result.mrUrl) {
              console.log(chalk.cyan(`   MR: ${result.mrUrl}`));
            }
            process.exit(0);
          } else {
            console.log(chalk.yellow('\n⚠️  QA did not pass'));
            process.exit(1);
          }
        }

        if (options.prdIid) {
          console.log(chalk.cyan(`\n🔍 Running PRD-level QA for PRD #${options.prdIid}...\n`));
          const result = await runner.processPRD(options.prdIid);

          console.log(chalk.bold('\n📊 PRD QA Results:\n'));
          for (const r of result.results) {
            const icon = r.passed ? chalk.green('✅') : chalk.red('❌');
            console.log(`  ${icon} #${r.iid} ${r.passed ? 'passed' : 'failed'}`);
          }
          console.log(chalk.gray(`\n  Total: ${result.results.length}`));

          if (result.success) {
            console.log(chalk.green('\n✅ All PRD issues passed QA!'));
            process.exit(0);
          } else {
            console.log(chalk.yellow('\n⚠️  Some PRD issues did not pass QA'));
            process.exit(1);
          }
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * qa start — continuous QA polling worker
   */
  qa
    .command('start')
    .description('Start continuous QA polling worker (polls for stage::qa issues)')
    .option('--poll-interval <seconds>', 'Polling interval in seconds', '120')
    .action(async (options) => {
      try {
        const tracker = await createTrackerClient();
        const runner = new QARunner(tracker);
        const pollInterval = parseInt(options.pollInterval) * 1000;

        console.log(chalk.cyan('\n🔍 QA Worker Started'));
        console.log(chalk.gray(`   Polling for stage::qa issues every ${options.pollInterval}s\n`));

        const poll = async () => {
          try {
            const issues = await tracker.listIssues({
              labels: ['stage::qa'],
              state: 'opened',
            });

            for (const issue of issues) {
              logger.info({ iid: issue.id }, 'QA worker picked up issue');
              console.log(chalk.cyan(`  [QA] Processing #${issue.id}...`));

              const result = await runner.process(issue.id);
              console.log(
                result.success
                  ? chalk.green(`  [QA] ✅ #${issue.id} passed`)
                  : chalk.yellow(`  [QA] ⚠️  #${issue.id} failed`)
              );
            }
          } catch (error) {
            logger.error({ err: (error as Error).message }, 'QA poll cycle error');
          }
        };

        // Initial poll
        await poll();

        // Continuous polling
        setInterval(poll, pollInterval);

        console.log(chalk.dim('\nPress Ctrl+C to stop\n'));

        process.on('SIGINT', () => {
          console.log('\n\nQA worker stopped.');
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          console.log('\n\nQA worker stopped.');
          process.exit(0);
        });
      } catch (error) {
        handleCommandError(error);
      }
    });
}