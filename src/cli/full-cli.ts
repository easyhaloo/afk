/**
 * Full CLI - loads all command modules.
 * Fallback for: unknown commands.
 */
import { Command } from 'commander';
import '../infrastructure/io/logger';
import { COMMANDS } from './command-registry.js';

export async function runFullCLI() {
  const program = new Command();
  program.name('afk').version('0.1.0');
  const registerFns = await Promise.all(COMMANDS.map(command => command.loader()));
  for (const register of registerFns) register(program);
  program.parse();
}
