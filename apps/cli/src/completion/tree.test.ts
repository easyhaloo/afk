import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { buildCompletionTree } from './tree.js';

describe('buildCompletionTree', () => {
  it('registers every completable top-level command (board excluded)', () => {
    const program: Command = buildCompletionTree();
    const names = program.commands.map(c => c.name()).sort();
    expect(names).toEqual([
      'backlog', 'debug', 'graph', 'isolate', 'kanban', 'log', 'loop', 'observe',
      'qa', 'run', 'signal', 'tmux',
    ]);
  });

  it('completes the short log command with the shared run argument and options', () => {
    const command = buildCompletionTree().commands.find(candidate => candidate.name() === 'log');
    expect(command?.registeredArguments.map(argument => argument.name())).toEqual(['runId']);
    expect(command?.options.map(option => option.long)).toEqual(expect.arrayContaining(['--root', '--watch', '--tail', '--json']));
  });
});
