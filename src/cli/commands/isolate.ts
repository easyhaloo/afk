import { Command } from 'commander';
import { basename } from 'path';
import { IsolateManager } from '../../application/isolate';
import { handleCommandError, success, info, fail } from '../cli-utils';

function createIsolate(cwd?: string): IsolateManager {
  return new IsolateManager(cwd ?? process.cwd());
}

export function registerIsolateCommands(program: Command): void {
  const isolate = program
    .command('isolate')
    .description('DB service isolation — per-worktree isolated middleware containers');

  isolate
    .command('available')
    .description('Check if isolate is available (docker-compose.yml must exist)')
    .action(() => {
      const im = createIsolate();
      if (im.available()) {
        success('Isolate available');
      } else {
        fail('Isolate not available (no docker-compose.yml found)');
      }
    });

  isolate
    .command('up [worktree-root]')
    .description('Start isolate: parse docker-compose.yml, allocate ports, start containers')
    .action(async (worktreeRoot?: string) => {
      try {
        const root = worktreeRoot ?? process.cwd();
        const im = createIsolate(root);
        if (!im.available()) {
          handleCommandError(new Error(`No docker-compose.yml found in ${root}`));
        }

        info('Starting isolate...');
        await im.up();
        success('Isolate started');
      } catch (err) {
        handleCommandError(err);
      }
    });

  isolate
    .command('down [worktree-root]')
    .description('Destroy isolate: stop and remove containers')
    .action(async (worktreeRoot?: string) => {
      try {
        const root = worktreeRoot ?? process.cwd();
        const im = createIsolate(root);
        await im.discard();
        success('Isolate destroyed');
      } catch (err) {
        handleCommandError(err);
      }
    });
}