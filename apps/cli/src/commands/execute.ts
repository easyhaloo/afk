import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { executeWorkItem, reconcileWorkItemMerge } from '@afk/runtime/execution';
import { createDefaultPluginRuntime, type PluginRuntime } from '@afk/runtime/plugin-sdk';
import { detail, handleCommandError, success, warning } from '../output.js';
import type { CommandRegistrationContext } from '../command-registry.js';

export function registerExecuteCommands(program: Command, composition: CommandRegistrationContext = {}): void {
  program.command('reconcile')
    .description('Verify a human-merged root PR and reconcile its execution audit')
    .requiredOption('--work-item-id <id>', 'Canonical provider-qualified work item ID')
    .option('--execution-manifest <path>', 'Execution manifest (default: managed work item configuration)')
    .requiredOption('--execution-id <id>', 'Original execution attempt ID')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        const input = { workItemId: options.workItemId,
          manifestPath: options.executionManifest, executionId: options.executionId, project: options.project };
        const result = composition.pluginRuntime
          ? await reconcileWorkItemMerge(input, { plugins: composition.pluginRuntime, agentProviderRegistry: composition.pluginRuntime.getAgentProviderRegistry() })
          : await reconcileWorkItemMerge(input);
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
    .option('--execution-manifest <path>', 'Execution manifest (default: managed work item configuration)')
    .option('--template <name>', 'Implementation workflow template')
    .option('--project <project>', 'Provider project/repository')
    .option('--execution-id <id>', 'Attempt ID (default: generated UUID)')
    .action(async options => {
      try {
        let plugins: PluginRuntime | undefined;
        try {
          plugins = composition.pluginRuntime ?? await createDefaultPluginRuntime({ warn: message => warning(message) });
          const result = await executeWorkItem({
            workItemId: options.workItemId,
            manifestPath: options.executionManifest,
            template: options.template,
            project: options.project,
            executionId: options.executionId ?? randomUUID(),
          }, { plugins, agentProviderRegistry: plugins.getAgentProviderRegistry() });
          if (result.status !== 'merge_ready' && result.status !== 'done') {
            warning(`Work item execution stopped: ${result.status}`);
            process.exitCode = 1;
            return;
          }
          success(`Work item ${result.status === 'merge_ready' ? 'awaits human merge' : 'merged'}`);
          if (result.changeUrl) detail(`Change: ${result.changeUrl}`);
        } finally {
          if (plugins !== composition.pluginRuntime) await plugins?.dispose();
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}
