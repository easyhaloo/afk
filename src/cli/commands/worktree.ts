import { Command } from 'commander';
import chalk from 'chalk';
import { WorktreeManager } from '../../infrastructure/git/worktree';
import { getWorktreeConfig } from '../../infrastructure/config/manager';
import { handleCommandError, success, warning, detail, formatJson } from '../cli-utils';

export function registerWorktreeCommands(program: Command): void {
  const worktree = program
    .command('worktree')
    .description('Git worktree management with state tracking');

  /**
   * create command
   */
  worktree
    .command('create')
    .description('Create new worktree for issue')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .requiredOption('--branch <branch>', 'Base branch to branch from')
    .option('--base-dir <path>', 'Base directory for worktrees', '/tmp/afk-worktrees')
    .action(async (options) => {
      try {
        const cfg = getWorktreeConfig();
        const manager = new WorktreeManager();
        const wt = await manager.create(options.iid, options.branch, options.baseDir ?? cfg.baseDir);

        success('Worktree created');
        detail(`Issue: #${wt.iid}`);
        detail(`Path: ${wt.path}`);
        detail(`Branch: ${wt.branch}`);
        console.log();
        console.log(chalk.dim(`cd ${wt.path}`));
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * get command
   */
  worktree
    .command('get')
    .description('Get worktree info by IID')
    .argument('<iid>', 'Issue IID', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (iid: number, options) => {
      try {
        const manager = new WorktreeManager();
        const wt = await manager.get(iid);

        if (!wt) {
          warning(`Worktree for issue #${iid} not found`);
          process.exit(1);
        }

        if (options.json) {
          formatJson(wt);
        } else {
          console.log(chalk.bold(`Worktree for issue #${wt.iid}`));
          console.log(chalk.gray(`  Path: ${wt.path}`));
          console.log(chalk.gray(`  Branch: ${wt.branch}`));
          console.log(chalk.gray(`  Status: ${wt.status}`));
          console.log(chalk.gray(`  Created: ${wt.createdAt.toISOString()}`));
          if (wt.sessionId) {
            console.log(chalk.gray(`  Session: ${wt.sessionId}`));
          }
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * list command
   */
  worktree
    .command('list')
    .description('List all worktrees')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const manager = new WorktreeManager();
        const worktrees = await manager.list();

        if (options.json) {
          formatJson(worktrees);
        } else {
          console.log(chalk.bold(`Found ${worktrees.length} worktrees:`));
          console.log();

          worktrees.forEach(wt => {
            const displayStatus = wt.markerStatus || wt.status;
            const statusColor =
              displayStatus === 'crashed' ? chalk.red :
              displayStatus === 'success' ? chalk.blue :
              displayStatus === 'active' ? chalk.green :
              displayStatus === 'completed' ? chalk.blueBright :
              chalk.red;
            console.log(`  ${chalk.cyan(`#${wt.iid}`)} ${statusColor(`[${displayStatus}]`)}`);
            console.log(chalk.gray(`    ${wt.path}`));
            console.log(chalk.gray(`    ${wt.branch}`));
            console.log();
          });
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * cleanup command
   */
  worktree
    .command('cleanup')
    .description('Remove worktree')
    .argument('<iid>', 'Issue IID', parseInt)
    .option('--force', 'Force cleanup even with uncommitted changes')
    .action(async (iid: number, options) => {
      try {
        const manager = new WorktreeManager();
        await manager.cleanup(iid, options.force);

        success(`Worktree for issue #${iid} removed`);
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * list-orphaned command
   */
  worktree
    .command('list-orphaned')
    .description('List orphaned worktrees (no matching tmux session)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const manager = new WorktreeManager();
        const orphaned = await manager.listOrphaned();

        if (options.json) {
          formatJson(orphaned);
        } else {
          if (orphaned.length === 0) {
            success('No orphaned worktrees found');
          } else {
            warning(`Found ${orphaned.length} orphaned worktrees:`);
            console.log();

            orphaned.forEach(wt => {
              console.log(`  ${chalk.cyan(`#${wt.iid}`)} ${chalk.gray(wt.path)}`);
              console.log(chalk.gray(`    Branch: ${wt.branch}`));
              console.log(chalk.gray(`    Session: ${wt.sessionId || 'none'}`));
              console.log();
            });

            console.log(chalk.dim('Run `afk worktree prune` to clean up'));
          }
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * clean command
   */
  worktree
    .command('clean')
    .description('Clean worktrees by status marker and/or age')
    .option('--crashed', 'Clean CRASHED worktrees')
    .option('--success', 'Clean SUCCESS worktrees')
    .option('--stale', 'Clean STALE worktrees (inactive >7 days, no active session)')
    .option('--all', 'Clean ALL worktrees including ACTIVE (dangerous)')
    .option('--days <n>', 'Only clean worktrees older than N days', parseInt)
    .option('--dry-run', 'Show what would be removed without actually removing')
    .option('--force', 'Skip confirmation prompt')
    .action(async (options) => {
      try {
        const manager = new WorktreeManager();

        // Determine marker status filter
        let markerStatus: 'crashed' | 'success' | 'all' | undefined;
        if (options.crashed) markerStatus = 'crashed';
        else if (options.success) markerStatus = 'success';
        else if (options.all) markerStatus = 'all';

        const { deleted, skipped } = await manager.clean({
          markerStatus,
          stale: options.stale,
          olderThanDays: options.days,
          dryRun: options.dryRun,
        });

        if (options.dryRun) {
          warning(`Would remove ${deleted} worktree(s) (skipped: ${skipped})`);
        } else {
          success(`Removed ${deleted} worktree(s) (skipped: ${skipped})`);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * prune command
   */
  worktree
    .command('prune')
    .description('Remove all orphaned worktrees')
    .option('--dry-run', 'Show what would be removed without actually removing')
    .action(async (options) => {
      try {
        const manager = new WorktreeManager();
        const count = await manager.prune(options.dryRun);

        if (options.dryRun) {
          warning(`Would remove ${count} orphaned worktrees`);
        } else {
          success(`Removed ${count} orphaned worktrees`);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * update-status command
   */
  worktree
    .command('update-status')
    .description('Update worktree status')
    .argument('<iid>', 'Issue IID', parseInt)
    .argument('<status>', 'New status (active, completed, failed)')
    .action(async (iid: number, status: string) => {
      try {
        if (!['active', 'completed', 'failed'].includes(status)) {
          throw new Error('Status must be: active, completed, or failed');
        }

        const manager = new WorktreeManager();
        await manager.updateStatus(iid, status as 'active' | 'completed' | 'failed');

        success(`Updated worktree #${iid} status to: ${status}`);
      } catch (error) {
        handleCommandError(error);
      }
    });
}
