import { Command } from 'commander';
import { describeScheduleWaitReason, scheduleWorkItems } from '@afk/runtime/execution';
import { handleCommandError, detail, warning } from '../output.js';

export function registerScheduleCommands(program: Command): void {
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
      let inventoryBlind = false;
      // The last scope failure that was printed. A failure that does not
      // change is not printed again: the schedule polls every thirty seconds
      // and the operator reads the terminal, not a wall of the same line.
      let scopeSignature = '';
      try {
        const result = await scheduleWorkItems({ parent: options.parent, maxConcurrent: options.maxConcurrent,
          loadLimit: options.loadLimit, pollIntervalMs: options.pollInterval, watch: options.watch, dryRun: options.dryRun, signal: controller.signal,
          onStatus: status => {
            if (!options.json && status.overloaded !== paused) {
              if (status.overloaded) warning('System overloaded; pausing new executions');
              else detail('System load recovered; resuming scheduling');
            }
            paused = status.overloaded;
            // The scheduler is alive but it cannot see the work items. That
            // is not the same as having nothing to do, and an operator who
            // cannot tell them apart reads a quiet terminal as a stalled PRD.
            if (status.inventoryUnavailable) {
              if (inventoryBlind) return;
              inventoryBlind = true;
              const failure = status.inventoryUnavailable;
              warning(`Cannot read the work item inventory (${failure.error}); the scheduler is still running and retries in ${Math.round(failure.retryInMs / 1000)}s`);
            } else if (inventoryBlind) {
              inventoryBlind = false;
              detail('Work item inventory is available again');
            }
            // A project outside this PRD's scope that cannot be read is named
            // and nothing more: it does not stop the schedule. A project
            // inside the scope does stop the work that depends on it, and
            // the operator has to know that it did.
            const scope = status.scope;
            if (!scope || (!scope.reported.length && !scope.unreadable.length)) return;
            const signature = [...scope.reported, ...scope.unreadable]
              .map(diagnostic => `${diagnostic.platform}:${diagnostic.projectKey}:${diagnostic.code}`).join('|');
            if (signature === scopeSignature) return;
            scopeSignature = signature;
            for (const diagnostic of scope.reported) {
              warning(`Cannot read ${diagnostic.projectKey} (${diagnostic.message}); it is outside this PRD's scope, so the schedule continues`);
            }
            for (const diagnostic of scope.unreadable) {
              warning(`Cannot read ${diagnostic.projectKey} (${diagnostic.message}); it is inside this PRD's scope, so the work that depends on it is held back`);
            }
          } });
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
          if (result.scope?.heldBack.length) {
            detail(`Held back because a dependency could not be read: ${result.scope.heldBack.join(', ')}`);
          }
        }
        if (result.executions.some(execution => execution.status === 'blocked')) process.exitCode = 1;
        // A scope AFK cannot see is not a clean run: the report says so.
        if (result.scope?.unreadable.length) process.exitCode = 1;
      } catch (error) { handleCommandError(error); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    });
}
