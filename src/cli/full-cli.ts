/**
 * Full CLI - loads all command modules.
 * Fallback for: unknown commands.
 */
import '@afk/infrastructure/io';
import { buildCommandProgram } from './command-registry.js';

export async function runFullCLI() {
  const program = await buildCommandProgram();
  await program.parseAsync();
}
