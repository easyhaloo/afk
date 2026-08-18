import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { buildCompletionTree } from '../../cli/completion/tree';

describe('buildCompletionTree', () => {
  it('registers every completable top-level command (board excluded)', () => {
    const program: Command = buildCompletionTree();
    const names = program.commands.map(c => c.name()).sort();
    expect(names).toEqual([
      'backlog', 'debug', 'isolate', 'kanban', 'loop',
      'qa', 'run', 'signal', 'tmux',
    ]);
  });
});
