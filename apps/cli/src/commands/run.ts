import { Command, InvalidArgumentError } from 'commander';
import { handleCommandError, success, warning, detail } from '../output.js';
import { runWorkflowCli } from '@afk/runtime/application/workflows/run-cmd';
import { getWorkflowConfig } from '@afk/runtime/infrastructure/config/manager';
import type { CodexRuntimeOverrides } from '@afk/runtime/domain/agents/codex-runtime';
import { createDefaultPluginRuntime, type PluginRuntime } from '@afk/runtime/plugin-sdk';
import type { CommandRegistrationContext } from '../command-registry.js';
import { addAgentRuntimeOptions } from './agent-runtime-options.js';

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got '${value}'`);
  }
  return parsed;
}
export function registerRunCommands(program: Command, composition: CommandRegistrationContext = {}): void {
  const command = program
    .command('run')
    .description('Execute a workflow')
    .requiredOption('--backlog-id <id>', 'Backlog ID')
    .option('--session <name>', 'Session name (default: afk-<work-item-id>; learning: generated unique name)')
    .option('--project <project>', 'Provider project/repository')
    .option('--target-branch <branch>', 'Working branch (MR target comes from the work item execution refs)')
    .option('--base-branch <branch>', 'Base branch for the worktree')
    .option('--execution-manifest <path>', 'Execution manifest for a multi-repository workspace')
    .option('--max-retries <n>', 'Maximum retry attempts', positiveInt)
    .option('--hard-timeout <ms>', 'Hard timeout in milliseconds', positiveInt)
    .option('--max-handoffs <n>', 'Maximum context-handoff rounds', positiveInt)
    .option('--context-high <tokens>', 'Context token threshold', positiveInt)
    .option('--max-total-tokens <tokens>', 'Maximum total tokens', positiveInt)
    .option('--ext <modules...>', 'Lifecycle modules to activate')
    .option('--ext-param <params...>', 'Lifecycle module parameters')
    .option('--sandbox <provider>', 'Registered sandbox provider')
    .option('--agent <name>', 'Agent provider')
    .option('--execution-mode <mode>', 'Agent execution mode: interactive | batch')
    .option('--template <name>', 'Workflow template name');
  addAgentRuntimeOptions(command)
    .action(async options => {
      let ownedRuntime: PluginRuntime | undefined;
      try {
        const plugins = composition.pluginRuntime ?? (ownedRuntime = await createDefaultPluginRuntime());
        const cfg = getWorkflowConfig();
        const agentRuntimeOverrides: CodexRuntimeOverrides = {
          transport: options.agentTransport,
          auth: options.agentAuth,
          provider: options.agentProvider,
          profile: options.agentProfile,
          endpoint: options.agentAppServer,
          authTokenEnv: options.agentAppServerAuthEnv,
        };
        const goalBudget = cfg.goalBudget || 500_000;
        const result = await runWorkflowCli({
          backlogId: options.backlogId,
          session: options.session,
          projectName: options.project,
          targetBranch: options.targetBranch,
          baseBranch: options.baseBranch,
          executionManifestPath: options.executionManifest,
          maxRetries: options.maxRetries ?? cfg.maxRetries,
          hardTimeoutMs: options.hardTimeout ?? cfg.workflowHardTimeout,
          maxHandoffs: options.maxHandoffs ?? (Math.min(Math.ceil(goalBudget / 1_000_000), 20) || 3),
          contextHighTokens: options.contextHigh ?? cfg.contextThreshold,
          maxTotalTokens: options.maxTotalTokens ?? goalBudget,
          ext: options.ext,
          extParams: options.extParam,
          sandboxProvider: options.sandbox,
          agentProvider: options.agent,
          ...(Object.values(agentRuntimeOverrides).some(value => value !== undefined)
            ? { agentRuntimeOverrides } : {}),
          plugins,
          executionMode: options.executionMode,
          template: options.template,
        });
        if (!result.success) {
          warning('Workflow did not complete successfully');
          process.exitCode = 1;
          return;
        }
        success('Workflow completed');
        if (result.url) detail(`Change: ${result.url}`);
      } catch (error) {
        handleCommandError(error);
      } finally { await ownedRuntime?.dispose(); }
    });
}
