import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { buildCompletionTree } from './tree';
import { buildCompletionTree as buildCanonicalCompletionTree } from '../../cli/completion/tree';

describe('buildCompletionTree', () => {
  it('delegates to the canonical CLI completion tree', () => {
    expect(buildCompletionTree).toBe(buildCanonicalCompletionTree);
  });

  it('registers every completable top-level command (board excluded)', () => {
    const program: Command = buildCompletionTree();
    const names = program.commands.map(c => c.name());
    expect(names).toEqual(expect.arrayContaining([
      'backlog', 'debug', 'graph', 'isolate', 'kanban', 'loop',
      'observe', 'qa', 'run', 'signal', 'tmux',
    ]));
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('board');
  });
});
