import { Command } from 'commander';
import { createManagementProviders } from '../../application/tracker-provider-factory';
import { QARunner } from '../../application/modules/qa-runner';
import { handleCommandError, success, warning, detail } from '../cli-utils';
import { getWorkflowConfig } from '../../infrastructure/config/manager';
import { createAgentProvider, prepareAgentRuntime, resolveAgentProviderName } from '../../domain/agents/index';
import { addAgentRuntimeOptions, resolveAgentRuntimeOptions } from './agent-runtime-options';

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
        // not require an implementation-only atomic claim capability.
        const providers = await createManagementProviders(options.project, process.cwd());
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
