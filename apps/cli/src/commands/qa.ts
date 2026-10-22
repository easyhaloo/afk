import { Command } from 'commander';
import { createManagementProviders } from '@afk/runtime/infrastructure/provider/tracker-provider-factory';
import { resolveTrackerTarget } from '@afk/runtime/infrastructure/tracker/target';
import { QARunner } from '@afk/runtime/application/modules/qa-runner';
import { handleCommandError, success, warning, detail } from '../cli-utils.js';
import { getWorkflowConfig } from '@afk/runtime/infrastructure/config/manager';
import { createAgentProvider, prepareAgentRuntime, resolveAgentProviderName } from '@afk/runtime/domain/agents/index';
import { addAgentRuntimeOptions, resolveAgentRuntimeOptions } from './agent-runtime-options.js';

/**
 * Run QA for one item already awaiting verification. Loop invokes the same
 * QARunner service after implementation; this command is its manual retry and
 * diagnostic entry point.
 */
export function registerQACommands(program: Command): void {
  const command = program
    .command('qa')
    .description('Verify one backlog item and publish its change for the appropriate merge policy')
    .requiredOption('--backlog-id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .option('--mode <mode>', 'Agent execution mode: batch or interactive', 'batch')
    .option('--agent <name>', 'Agent provider');
  addAgentRuntimeOptions(command)
    .action(async options => {
      try {
        if (options.mode !== 'batch' && options.mode !== 'interactive') {
          throw new Error(`invalid QA execution mode: ${options.mode}`);
        }
        const config = getWorkflowConfig();
        const agentProviderName = resolveAgentProviderName(options.agent ?? config.agentDefault);
        const agentRuntime = await prepareAgentRuntime(resolveAgentRuntimeOptions(agentProviderName, config, options));
        const agentProvider = createAgentProvider(agentProviderName);
        // QA never claims work; use the management bundle so verification does
        // not require an implementation-only atomic claim capability. The
        // backlog id takes part in the target lookup, so QA also works from a
        // directory that is not a git repository.
        const target = await resolveTrackerTarget({
          project: options.project,
          issueId: options.backlogId,
          cwd: process.cwd(),
        });
        const providers = await createManagementProviders(target.projectId, process.cwd(), target.platform, target.host);
        const item = await providers.backlog.get(options.backlogId);
        if (item.state !== 'verification') {
          throw new Error(`backlog ${item.id} is in ${item.state}; QA requires verification state`);
        }
        const runner = new QARunner(providers, config, { executionMode: options.mode, agentProvider, agentRuntime });
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
