/**
 * Full CLI - loads all command modules.
 * Fallback for: unknown commands.
 */
import { Command } from 'commander';
// Logger auto-initializes on import (creates ~/.afk/ dir, suppresses Octokit warnings)
import './lib/core/io/logger';
import { COMMANDS } from './command-registry.js';

export async function runFullCLI() {
  const program = new Command();
  program.name('afk').version('0.1.0');
  // One registry feeds both paths - see command-registry.ts. Loading all
  // register fns in parallel keeps the fallback as fast as it can be.
  const registerFns = await Promise.all(COMMANDS.map(c => c.loader()));
  for (const register of registerFns) register(program);
  program.parse();
}
