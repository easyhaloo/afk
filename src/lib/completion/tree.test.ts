import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { buildCompletionTree } from './tree';

describe('buildCompletionTree', () => {
  it('registers every completable top-level command (board excluded)', () => {
    const program: Command = buildCompletionTree();
    const names = program.commands.map(c => c.name()).sort();
    expect(names).toEqual([
      'debug', 'escalate', 'isolate', 'issue',
      'kanban', 'loop', 'mr', 'qa', 'scheduler', 'signal', 'tmux',
      'workflow', 'worktree',
    ]);
  });
});
