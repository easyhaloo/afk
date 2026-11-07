import { Command } from 'commander';
import { assembleProviders } from '@afk/runtime/infrastructure/provider/assembly';
import { QARunner } from '@afk/runtime/application/runners/qa-runner';
import { handleCommandError, success, warning, detail } from '../output.js';
import { getWorkflowConfig, repositoryExecutionDefaults } from '@afk/runtime/infrastructure/config/manager';
import { prepareAgentRuntime, resolveAgentProviderName } from '@afk/runtime/domain/agents/index';
import { createDefaultPluginRuntime, type PluginRuntime } from '@afk/runtime/plugin-sdk';
import { WorktreeManager } from '@afk/runtime/infrastructure/git/worktree';
import { addAgentRuntimeOptions, resolveAgentRuntimeOptions } from './agent-runtime-options.js';
import { resolveWorkflowRunRequest, parseExecutionPlan } from '@afk/runtime/execution';
import { resolveParentPrdBaseline, resolvePrdExecutionPlan } from '@afk/runtime/domain/backlog/prd-baseline';
import type { CommandRegistrationContext } from '../command-registry.js';

/**
 * Run QA for one item already awaiting verification. Loop invokes the same
 * QARunner service after implementation; this command is its manual retry and
 * diagnostic entry point.
 */
export function registerQACommands(program: Command, composition: CommandRegistrationContext = {}): void {
  const command = program
    .command('qa')
    .description('Verify one backlog item and publish its change for the appropriate merge policy')
    .requiredOption('--backlog-id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .option('--execution-manifest <path>', 'Execution manifest (default: managed work item configuration when present)')
    .option('--mode <mode>', 'Agent execution mode: batch or interactive', 'batch')
    .option('--agent <name>', 'Agent provider');
  addAgentRuntimeOptions(command)
    .action(async options => {
      try {
        let plugins: PluginRuntime | undefined;
        try {
          if (options.mode !== 'batch' && options.mode !== 'interactive') {
            throw new Error(`invalid QA execution mode: ${options.mode}`);
          }
          const config = getWorkflowConfig();
          plugins = composition.pluginRuntime ?? await createDefaultPluginRuntime({ warn: message => warning(message) });
          const agentProviderRegistry = plugins.getAgentProviderRegistry();
          const agentProviderName = resolveAgentProviderName(options.agent ?? config.agentDefault, agentProviderRegistry);
          const agentRuntime = await prepareAgentRuntime(resolveAgentRuntimeOptions(agentProviderName, config, options));
          const request = await resolveWorkflowRunRequest({
            backlogId: options.backlogId, projectName: options.project, executionManifestPath: options.executionManifest,
            agentProvider: agentProviderName, executionMode: options.mode,
          }, config, { agentProviderRegistry });
          const { management: providers } = await assembleProviders({ workItemId: request.workItemId,
            projectId: request.trackerProjectId, projectKey: request.trackerProjectKey,
            cwd: request.repoRoot, platform: request.trackerPlatform, providerHost: request.trackerHost, plugins });
          const item = await providers.backlog.get(request.backlogId);
          if (item.state !== 'verification') {
            throw new Error(`backlog ${item.id} is in ${item.state}; QA requires verification state`);
          }
          // The plan the item is verified against: the manifest record when a
          // managed run left one, the body's own declaration otherwise. A slice
          // of a PRD that says nothing itself inherits that PRD's baseline
          // branch, which is where the PRD accumulates its slices.
          const prdBaseline = await resolveParentPrdBaseline(item.parentId, id => providers.backlog.get(id));
          const plan = resolvePrdExecutionPlan({
            plan: request.executionPlan ?? parseExecutionPlan(item.description),
            prdBaseline,
            fallback: repositoryExecutionDefaults(config, request.trackerProjectKey, request.repoRoot),
          });
          const runner = new QARunner(providers, config, { executionMode: options.mode, plugins, agentProviderRegistry, agentRuntime,
            agentProvider: agentProviderRegistry.require(request.agentProvider),
            sandboxProvider: plugins.getSandboxProviderRegistry().create(request.sandboxProvider, {
              worktreeManager: new WorktreeManager(),
            }),
            projectRoot: request.workspaceRoot, repositories: request.repositories?.map(repository => repository.primary
              ? { ...repository, baseBranch: plan.baseRef, targetBranch: plan.targetRef, sourceBranch: plan.sourceRef } : repository), executionPlan: plan });
          const result = await runner.process(request.backlogId);
          if (!result.success) {
            warning('QA did not pass');
            process.exitCode = 1;
            return;
          }
          success('QA passed');
          if (result.mrUrl) detail(`Change: ${result.mrUrl}`);
        } finally {
          if (plugins !== composition.pluginRuntime) await plugins?.dispose();
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}
