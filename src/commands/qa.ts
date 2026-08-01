import { Command } from 'commander';
import chalk from 'chalk';
import { createTrackerClient } from '../lib/client-factory';
import { QARunner } from '../lib/qa-runner';
import { handleCommandError, success, info, warning, detail } from '../lib/cli-utils';
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
          handleCommandError(new Error('Either --iid or --prd-iid is required'));
        }

        const tracker = await createTrackerClient();
        const runner = new QARunner(tracker);

        if (options.iid) {
          info(`Running QA for issue #${options.iid}...`);
          const result = await runner.process(options.iid);

          if (result.success) {
            success('QA passed!');
            if (result.mrUrl) {
              detail(`MR: ${result.mrUrl}`);
            }
            process.exit(0);
          } else {
            warning('QA did not pass');
            process.exit(1);
          }
        }

        if (options.prdIid) {
          info(`Running PRD-level QA for PRD #${options.prdIid}...`);
          const result = await runner.processPRD(options.prdIid);

          console.log(chalk.bold('\n📊 PRD QA Results:\n'));
          for (const r of result.results) {
            const icon = r.passed ? chalk.green('✅') : chalk.red('❌');
            console.log(`  ${icon} #${r.iid} ${r.passed ? 'passed' : 'failed'}`);
          }
          console.log(chalk.gray(`\n  Total: ${result.results.length}`));

          if (result.success) {
            success('All PRD issues passed QA!');
            process.exit(0);
          } else {
            warning('Some PRD issues did not pass QA');
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

        info('QA Worker Started');
        detail(`Polling for stage::qa issues every ${options.pollInterval}s`);

        const poll = async () => {
          try {
            const issues = await tracker.listIssues({
              labels: ['stage::qa'],
              state: 'opened',
            });

            for (const issue of issues) {
              logger.info({ iid: issue.id }, 'QA worker picked up issue');
              info(`[QA] Processing #${issue.id}...`);

              const result = await runner.process(issue.id);
              if (result.success) success(`[QA] #${issue.id} passed`);
              else warning(`[QA] #${issue.id} failed`);
            }
          } catch (error) {
            logger.error({ err: error }, 'QA poll cycle error');
          }
        };

        // Initial poll
        await poll();

        // Continuous polling
        setInterval(poll, pollInterval);

        console.log(chalk.dim('\nPress Ctrl+C to stop\n'));

        process.on('SIGINT', () => {
          info('QA worker stopped.');
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          info('QA worker stopped.');
          process.exit(0);
        });
      } catch (error) {
        handleCommandError(error);
      }
    });
}