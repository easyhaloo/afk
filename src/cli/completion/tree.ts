import { Command } from 'commander';
import { buildCommandProgram } from '../command-registry.js';

/**
 * The command tree the shell completion is generated from.
 *
 * It is the registry's own program, so a command that exists is a command
 * that completes. The tree used to carry a second list of its own, and it
 * had already fallen behind: `execute`, `reconcile`, `retro` and
 * `completion` were missing from the shell completion while the registry
 * and the documentation both offered them.
 */
export async function buildCompletionTree(): Promise<Command> {
  return buildCommandProgram();
}
