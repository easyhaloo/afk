import { Command } from 'commander';
import { inspectWorkspaceDisk, loadReclamationConfig, reclaimWorkspaces } from '@afk/runtime/execution';
import { detail, handleCommandError, warning } from '../output.js';

export function registerDoctorCommands(program: Command): void {
  program.command('doctor')
    .description('Report repository caches, dependency pools, workspace disk usage, and reclaimable bytes')
    .option('--workspace-root <path>', 'Workspace cache root')
    .option('--cleanup <target>', 'Remove one safe completed generated workspace (exact work item ID/path) or unpinned dependency pool (exact path)')
    .option('--fix', 'Reclaim workspaces whose runs stopped heartbeating (ADR-0038)')
    .option('--json', 'Emit JSON')
    .action(async options => {
      try {
        const report = await inspectWorkspaceDisk({ root: options.workspaceRoot, cleanup: options.cleanup });
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else {
          const size = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
          detail(`Repositories: ${size(report.totals.repositoryBytes)}; dependencies: ${size(report.totals.dependencyBytes)}`);
          detail(`Workspaces: ${size(report.totals.workspaceBytes)}; reclaimable: ${size(report.totals.reclaimableBytes)}`);
          for (const repository of report.repositories) detail(`${repository.path}: ${size(repository.bytes)}, ${repository.checkouts} checkouts`);
          for (const dependency of report.dependencies) detail(`${dependency.path}: ${size(dependency.bytes)}, ${dependency.pinned ? 'referenced' : 'reclaimable'}`);
          for (const workspace of report.workspaces) detail(`${workspace.workItemId}: ${size(workspace.bytes)}, ${workspace.active === true ? 'active lease' : workspace.state ?? 'retained'}${workspace.reason ? `; ${workspace.reason}` : ''}`);
          if (report.cleanup) detail(`Cleanup ${report.cleanup.status}: ${report.cleanup.target}; reclaimed ${size(report.cleanup.bytes)}${report.cleanup.reason ? `; ${report.cleanup.reason}` : ''}`);
          for (const diagnostic of report.diagnostics) warning(diagnostic);
        }
        if (options.fix) {
          const reclamation = await reclaimWorkspaces({ root: options.workspaceRoot, graceMs: loadReclamationConfig().workspaceReclaimGrace });
          if (options.json) console.log(JSON.stringify(reclamation, null, 2));
          else {
            for (const workspace of reclamation.reclaimed) detail(`reclaimed ${workspace.workItemId}: ${(workspace.bytes / 1024 ** 2).toFixed(1)} MiB${workspace.capturedDependencies.length ? `, ${workspace.capturedDependencies.length} dependency set(s) pooled` : ''}`);
            for (const workspace of reclamation.skipped) detail(`skipped ${workspace.workItemId}: ${workspace.reason}`);
            for (const diagnostic of reclamation.diagnostics) warning(diagnostic);
          }
        }
        if (report.diagnostics.length) process.exitCode = 1;
      } catch (error) { handleCommandError(error); }
    });
}
