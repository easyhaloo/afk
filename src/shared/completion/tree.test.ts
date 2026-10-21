import { describe, it, expect } from 'vitest';
import { buildCompletionTree } from '../../cli/completion/tree.js';
import { COMMANDS } from '../../cli/command-registry.js';
import { extractSpec } from './spec.js';

/** The alias a person never types. */
const HIDDEN = new Set(['__complete']);

describe('buildCompletionTree', () => {
  it('registers every command the registry offers', async () => {
    const program = await buildCompletionTree();
    const names = new Set(program.commands.map(command => command.name()));
    for (const entry of COMMANDS) {
      for (const name of entry.names) {
        expect(names.has(name)).toBe(true);
      }
    }
  });

  it('offers every command the registry does, except the hidden alias', async () => {
    // The tree used to carry a list of its own, and it had already fallen
    // behind: `execute`, `reconcile`, `retro` and `completion` were missing
    // from the shell completion while the registry and the documentation
    // both offered them.
    const spec = extractSpec(await buildCompletionTree());
    const names = new Set(spec.commands.map(command => command.name));
    for (const entry of COMMANDS) {
      for (const name of entry.names) {
        if (HIDDEN.has(name)) continue;
        expect(names.has(name)).toBe(true);
      }
    }
  });
});
