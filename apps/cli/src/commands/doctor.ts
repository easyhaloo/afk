import { Command } from 'commander';
import { inspectWorkspaceDisk } from '@afk/runtime/execution';
import { detail, handleCommandError, warning } from '../output.js';

export function registerDoctorCommands(program: Command): void {
  program.command('doctor')
    .description('Report repository caches, dependency pools, workspace disk usage, and reclaimable bytes')
    .option('--workspace-root <path>', 'Workspace cache root')
    .option('--json', 'Emit JSON')
    .action(async options => {
      try {
        const report = await inspectWorkspaceDisk({ root: options.workspaceRoot });
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else {
          const size = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
          detail(`Repositories: ${size(report.totals.repositoryBytes)}; dependencies: ${size(report.totals.dependencyBytes)}`);
          detail(`Workspaces: ${size(report.totals.workspaceBytes)}; reclaimable: ${size(report.totals.reclaimableBytes)}`);
          for (const repository of report.repositories) detail(`${repository.path}: ${size(repository.bytes)}, ${repository.checkouts} checkouts`);
          for (const dependency of report.dependencies) detail(`${dependency.path}: ${size(dependency.bytes)}, ${dependency.pinned ? 'referenced' : 'reclaimable'}`);
          for (const workspace of report.workspaces) detail(`${workspace.workItemId}: ${size(workspace.bytes)}, ${workspace.active ? 'active lease' : workspace.state ?? 'retained'}`);
          for (const diagnostic of report.diagnostics) warning(diagnostic);
        }
        if (report.diagnostics.length) process.exitCode = 1;
      } catch (error) { handleCommandError(error); }
    });
}
