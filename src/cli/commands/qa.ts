import { Command } from 'commander';
import { createManagementProviders } from '../../application/tracker-provider-factory';
import { QARunner } from '../../application/modules/qa-runner';
import { handleCommandError, success, warning, detail } from '../cli-utils';
import { getWorkflowConfig } from '../../infrastructure/config/manager';

export function registerQACommands(program: Command): void {
  program
    .command('qa')
    .description('Verify one backlog item and publish its change for the appropriate merge policy')
    .requiredOption('--backlog-id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .option('--mode <mode>', 'Agent execution mode: batch or interactive', 'batch')
    .action(async options => {
      try {
        if (options.mode !== 'batch' && options.mode !== 'interactive') {
          throw new Error(`invalid QA execution mode: ${options.mode}`);
        }
        const providers = await createManagementProviders(options.project, process.cwd());
        const item = await providers.backlog.get(options.backlogId);
        if (item.state !== 'verification') {
          throw new Error(`backlog ${item.id} is in ${item.state}; QA requires verification state`);
        }
        const runner = new QARunner(providers, getWorkflowConfig(), { executionMode: options.mode });
        const result = await runner.process(options.backlogId);
        if (!result.success) {
          warning('QA did not pass');
          process.exitCode = 1;
          return;
        }
        success('QA passed');
        if (result.mrUrl) detail(`Change: ${result.mrUrl}`);
      } catch (error) {
        handleCommandError(error);
      }
    });
}
