import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerBacklogCommands } from './backlog';
import { registerRunCommands } from './run';
import { registerQACommands } from './qa';

function commandTree(register: (program: Command) => void): Command {
  const program = new Command();
  program.name('afk').exitOverride();
  register(program);
  return program;
}

describe('hard-cutover command surface', () => {
  it('exposes backlog management subcommands only', () => {
    const program = commandTree(registerBacklogCommands);
    const backlog = program.commands.find(command => command.name() === 'backlog');
    expect(backlog?.commands.map(command => command.name())).toEqual(['init', 'list', 'show', 'tag']);
    expect(backlog?.commands.flatMap(command => command.commands.map(child => child.name()))).toEqual(['add', 'remove']);
  });

  it('requires a string backlog id for run and qa', () => {
    const run = commandTree(registerRunCommands).commands.find(command => command.name() === 'run');
    const qa = commandTree(registerQACommands).commands.find(command => command.name() === 'qa');
    expect(run?.options.some(option => option.long === '--backlog-id' && option.required)).toBe(true);
    expect(qa?.options.some(option => option.long === '--backlog-id' && option.required)).toBe(true);
    expect(run?.options.some(option => option.long === '--iid')).toBe(false);
    expect(qa?.options.some(option => option.long === '--iid')).toBe(false);
  });
});
