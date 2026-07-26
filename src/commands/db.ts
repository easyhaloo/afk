import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs, existsSync } from 'fs';
import { join, basename } from 'path';
import { ForkManager, detectServices, loadServiceRegistry } from '../lib/fork-manager.js';

const fork = new ForkManager();

function requireFork(): void {
  if (!fork.available()) {
    console.error(chalk.red('Error: Fork tool not available (AFK_FORK_STACK_DIR not set or compose files unreadable)'));
    process.exit(1);
  }
}

export function registerDbCommands(program: Command): void {
  const db = program
    .command('db')
    .description('DB forking via middleware-fork-stack');

  db.command('available').description('Check if fork tool is configured').action(() => {
    if (fork.available()) {
      console.log(chalk.green('[OK] Fork tool available'));
    } else {
      console.log(chalk.yellow('[FAIL] Fork tool not available'));
    }
  });

  db
    .command('detect [repo-path]')
    .description('Detect DB services needed for a repo (default: cwd)')
    .action(async (repoPath?: string) => {
      try {
        const path = repoPath ?? process.cwd();
        const svcs = await detectServices(path);
        if (!svcs.length) {
          console.log(chalk.gray('No DB services detected'));
        } else {
          console.log(svcs.join(' '));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  db.command('services').description('List available DB services from registry').action(async () => {
    try {
      const svcs = await loadServiceRegistry();
      console.log(chalk.bold('Available services:'));
      for (const s of svcs) {
        const line = '  ' + s.name.padEnd(10) + '  base port ' + s.basePort + '  ' + s.displayName;
        console.log(line.replace(s.name, chalk.cyan(s.name)));
      }
    } catch (err) {
      console.error(chalk.red('Error:'), (err as Error).message);
      process.exit(1);
    }
  });

  db
    .command('up [fork-name]')
    .description('Create DB fork (default fork name = cwd basename)')
    .option('--services <csv>', 'Comma-separated service list (default: all)')
    .action(async (forkName?: string, options?: { services?: string }) => {
      try {
        requireFork();
        const name = forkName ?? basename(process.cwd());
        const svcs = options?.services?.split(',').map(s => s.trim()) ?? undefined;

        process.stdout.write(chalk.gray('Creating fork \'' + name + '\'...\n'));
        await fork.up({ forkName: name, services: svcs });

        const envSrc = fork.envFilePath(name);
        if (existsSync(envSrc)) {
          await fs.copyFile(envSrc, join(process.cwd(), '.env.fork'));
          const svcList = svcs?.join(', ') ?? 'all';
          console.log(chalk.green('[OK] Fork ready: .env.fork written (services: ' + svcList + ')'));
        } else {
          console.log(chalk.green('[OK] Fork \'' + name + '\' ready (no .env.local)'));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  db
    .command('discard [fork-name]')
    .description('Destroy a DB fork (idempotent)')
    .action(async (forkName?: string) => {
      try {
        requireFork();
        const name = forkName ?? basename(process.cwd());
        await fork.discard(name);
        console.log(chalk.green('[OK] Fork \'' + name + '\' discarded'));
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  db.command('list').description('List active fork containers').action(async () => {
    try {
      requireFork();
      const containers = await fork.listContainers('fork');
      if (!containers.length) {
        console.log(chalk.gray('No active forks'));
      } else {
        console.log(chalk.bold('Active forks:'));
        for (const c of containers) {
          console.log('  ' + c);
        }
      }
    } catch (err) {
      console.error(chalk.red('Error:'), (err as Error).message);
      process.exit(1);
    }
  });
}
