import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { getForkConfig } from '../lib/config-manager.js';

export function registerForkCommands(program: Command): void {
  const fork = program
    .command('fork')
    .description('DB service forking via middleware-fork-stack (MySQL/Redis/ES/Neo4j)');

  /**
   * fork available
   * Checks whether the fork binary is configured and usable.
   */
  fork
    .command('available')
    .description('Check if fork binary is configured')
    .action(() => {
      const cfg = getForkConfig();
      const bin = join(cfg.stackDir, 'bin', 'fork');

      if (!cfg.stackDir) {
        console.log('[SKIP] AFK_FORK_STACK_DIR is not set — DB forking disabled');
        process.exit(1);
      }

      try {
        fs.access(bin, fs.constants.X_OK);
        console.log(`[OK] Fork binary found: ${bin}`);
      } catch {
        console.error(`[FAIL] Fork binary not found or not executable: ${bin}`);
        process.exit(1);
      }
    });

  /**
   * fork detect [service]
   * Detect running service ports by scanning .afk/ markers or docker compose.
   */
  fork
    .command('detect')
    .description('Detect running services')
    .argument('[service]', 'Service to detect (mysql, redis, elasticsearch, neo4j)', undefined)
    .action(async (service: string | undefined) => {
      const cfg = getForkConfig();

      if (!cfg.stackDir) {
        console.error('ERROR: AFK_FORK_STACK_DIR is not set');
        process.exit(1);
      }

      const bin = join(cfg.stackDir, 'bin', 'fork');
      const args = service ? ['detect', service] : ['detect'];
      const result = spawnSync(bin, args, { encoding: 'utf-8', shell: false });

      if (result.status === 0) {
        console.log(result.stdout);
      } else {
        console.error(result.stderr || result.stdout);
        process.exit(result.status ?? 1);
      }
    });

  /**
   * fork services
   * List available services from fork binary --help.
   */
  fork
    .command('services')
    .description('List available services')
    .action(() => {
      const cfg = getForkConfig();
      const bin = join(cfg.stackDir, 'bin', 'fork');

      if (!cfg.stackDir) {
        console.error('ERROR: AFK_FORK_STACK_DIR is not set');
        process.exit(1);
      }

      const result = spawnSync(bin, ['services'], { encoding: 'utf-8', shell: false });
      process.stdout.write(result.stdout || result.stderr);
    });

  /**
   * fork up <name>
   * Start a DB fork for the given name.
   */
  fork
    .command('up')
    .description('Start a DB fork')
    .argument('<name>', 'Fork name (e.g. issue-42)')
    .option('--services <csv>', 'Comma-separated services to fork (default: all available)')
    .action((name: string, options) => {
      const cfg = getForkConfig();
      const bin = join(cfg.stackDir, 'bin', 'fork');

      if (!cfg.stackDir) {
        console.error('ERROR: AFK_FORK_STACK_DIR is not set');
        process.exit(1);
      }

      const args = ['up', name];
      if (options.services) {
        args.push('--services', options.services);
      }

      console.log(chalk.cyan(`Starting fork "${name}"...`));
      const result = spawnSync(bin, args, { encoding: 'utf-8', shell: false });

      if (result.status === 0) {
        console.log(chalk.green(`[OK] Fork "${name}" started`));
        if (result.stdout.trim()) console.log(result.stdout);
      } else {
        console.error(chalk.red(`[FAIL] ${result.stderr || result.stdout}`));
        process.exit(result.status ?? 1);
      }
    });

  /**
   * fork discard <name>
   * Stop and discard a DB fork (idempotent — safe to re-run).
   */
  fork
    .command('discard')
    .description('Stop and discard a DB fork (idempotent)')
    .argument('<name>', 'Fork name (e.g. issue-42)')
    .action((name: string) => {
      const cfg = getForkConfig();
      const bin = join(cfg.stackDir, 'bin', 'fork');

      if (!cfg.stackDir) {
        // Best-effort: document as no-op
        console.log(`[SKIP] AFK_FORK_STACK_DIR not set — nothing to discard for "${name}"`);
        return;
      }

      const result = spawnSync(bin, ['discard', name], { encoding: 'utf-8', shell: false });

      if (result.status === 0) {
        console.log(chalk.green(`[OK] Discarded fork "${name}"`));
      } else {
        // Best-effort: warn but don't fail
        console.warn(chalk.yellow(`[WARN] fork discard failed: ${result.stderr || result.stdout}`));
      }
    });

  /**
   * fork list
   * List running forks.
   */
  fork
    .command('list')
    .description('List running forks')
    .action(() => {
      const cfg = getForkConfig();
      const bin = join(cfg.stackDir, 'bin', 'fork');

      if (!cfg.stackDir) {
        console.error('ERROR: AFK_FORK_STACK_DIR is not set');
        process.exit(1);
      }

      const result = spawnSync(bin, ['list'], { encoding: 'utf-8', shell: false });
      process.stdout.write(result.stdout || result.stderr);
    });
}
