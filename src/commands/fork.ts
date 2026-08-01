import { Command } from 'commander';
import { basename } from 'path';
import { ForkManager } from '../lib/forks';
import { handleCommandError, success, info, fail } from '../lib/cli-utils';

function createFork(cwd?: string): ForkManager {
  return new ForkManager(cwd ?? process.cwd());
}

export function registerForkCommands(program: Command): void {
  const fork = program
    .command('fork')
    .description('DB service forking — per-worktree isolated middleware containers');

  fork
    .command('available')
    .description('Check if fork is available (docker-compose.yml must exist)')
    .action(() => {
      const fm = createFork();
      if (fm.available()) {
        success('Fork available');
      } else {
        fail('Fork not available (no docker-compose.yml found)');
      }
    });

  fork
    .command('up [worktree-root]')
    .description('Start fork: parse docker-compose.yml, allocate ports, start containers')
    .action(async (worktreeRoot?: string) => {
      try {
        const root = worktreeRoot ?? process.cwd();
        const fm = createFork(root);
        if (!fm.available()) {
          handleCommandError(new Error(`No docker-compose.yml found in ${root}`));
        }

        info('Starting fork...');
        await fm.up();
        success('Fork started');
      } catch (err) {
        handleCommandError(err);
      }
    });

  fork
    .command('down [worktree-root]')
    .description('Destroy fork: stop and remove containers')
    .action(async (worktreeRoot?: string) => {
      try {
        const root = worktreeRoot ?? process.cwd();
        const fm = createFork(root);
        await fm.discard();
        success('Fork destroyed');
      } catch (err) {
        handleCommandError(err);
      }
    });
}