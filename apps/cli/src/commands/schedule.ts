import { Command } from 'commander';
import { describeScheduleWaitReason, scheduleWorkItems } from '@afk/runtime/execution';
import { createDefaultPluginRuntime, type PluginRuntime } from '@afk/runtime/plugin-sdk';
import { handleCommandError, detail, warning } from '../output.js';
import type { CommandRegistrationContext } from '../command-registry.js';

export function registerScheduleCommands(program: Command, composition: CommandRegistrationContext = {}): void {
  program.command('schedule')
    .description('Schedule a PRD tree across repositories with bounded concurrency')
    .requiredOption('--parent <id>', 'Canonical PRD work item ID')
    .option('--max-concurrent <count>', 'Global execution limit', Number)
    .option('--load-limit <load>', 'Pause launches above this one-minute system load', Number)
    .option('--poll-interval <milliseconds>', 'Refresh interval between dispatch evaluations', Number)
    .option('--watch', 'Keep watching for merged dependencies and operator retries until stopped')
    .option('--dry-run', 'Preview dependency waves without claims, agents, or provider mutations')
    .option('--json', 'Emit the final scheduling report as JSON')
    .action(async options => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      let paused = false;
      try {
        let plugins: PluginRuntime | undefined;
        try {
          plugins = composition.pluginRuntime ?? await createDefaultPluginRuntime({ warn: message => warning(message) });
          const result = await scheduleWorkItems({ parent: options.parent, maxConcurrent: options.maxConcurrent,
            loadLimit: options.loadLimit, pollIntervalMs: options.pollInterval, watch: options.watch, dryRun: options.dryRun, signal: controller.signal,
            onStatus: status => {
              if (!options.json && status.overloaded !== paused) {
                if (status.overloaded) warning('System overloaded; pausing new executions');
                else detail('System load recovered; resuming scheduling');
              }
              paused = status.overloaded;
            } }, { plugins, agentProviderRegistry: plugins.getAgentProviderRegistry() });
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else {
            detail(`Capacity: ${result.capacity}; attempts: ${result.executions.length}; waiting: ${result.waiting.length}`);
            if (result.baselineBranch) detail(`Baseline branch: ${result.baselineBranch}`);
            for (const [index, wave] of (result.waves ?? []).entries()) detail(`Wave ${index + 1} (after prior merges): ${wave.join(', ')}`);
            for (const execution of result.executions) detail(`${execution.workItemId}: ${execution.status}${execution.error ? ` (${execution.error})` : ''}`);
            for (const item of result.waiting) {
              // The wait reason names the constraint that binds — a missing
              // dependency, a full capacity, an overloaded host — so an operator
              // can tell "nothing to dispatch yet" from "no slot to dispatch
              // into".
              const reason = item.waitReason ? describeScheduleWaitReason(item.waitReason) : item.runnability.reason ?? 'waiting';
              detail(`${item.workItemId}: ${reason}`);
            }
          }
          if (result.executions.some(execution => execution.status === 'blocked')) process.exitCode = 1;
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          if (plugins !== composition.pluginRuntime) await plugins?.dispose();
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}
