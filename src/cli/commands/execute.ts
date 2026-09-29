import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { executeWorkItem, reconcileWorkItemMerge } from '../../application/workflows/execute-work-item';
import { detail, handleCommandError, success, warning } from '../cli-utils';

export function registerExecuteCommands(program: Command): void {
  program.command('reconcile')
    .description('Verify a human-merged root PR and reconcile its execution audit')
    .requiredOption('--work-item-id <id>', 'Canonical provider-qualified work item ID')
    .requiredOption('--execution-manifest <path>', 'Execution workspace manifest')
    .requiredOption('--execution-id <id>', 'Original execution attempt ID')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        const result = await reconcileWorkItemMerge({ workItemId: options.workItemId,
          manifestPath: options.executionManifest, executionId: options.executionId, project: options.project });
        if (result.status === 'merge_ready') {
          warning('Root PR still awaits human merge');
          process.exitCode = 1;
        }
        else success('Root PR merge verified; work item done');
        if (result.changeUrl) detail(`Change: ${result.changeUrl}`);
      } catch (error) {
        handleCommandError(error);
      }
    });

  program.command('execute')
    .description('Implement, independently verify, and publish one managed work item')
    .requiredOption('--work-item-id <id>', 'Canonical provider-qualified work item ID')
    .requiredOption('--execution-manifest <path>', 'Execution workspace manifest')
    .option('--template <name>', 'Implementation workflow template')
    .option('--project <project>', 'Provider project/repository')
    .option('--execution-id <id>', 'Attempt ID (default: generated UUID)')
    .action(async options => {
      try {
        const result = await executeWorkItem({
          workItemId: options.workItemId,
          manifestPath: options.executionManifest,
          template: options.template,
          project: options.project,
          executionId: options.executionId ?? randomUUID(),
        });
        if (result.status !== 'merge_ready' && result.status !== 'done') {
          warning(`Work item execution stopped: ${result.status}`);
          process.exitCode = 1;
          return;
        }
        success(`Work item ${result.status === 'merge_ready' ? 'awaits human merge' : 'merged'}`);
        if (result.changeUrl) detail(`Change: ${result.changeUrl}`);
      } catch (error) {
        handleCommandError(error);
      }
    });
}
