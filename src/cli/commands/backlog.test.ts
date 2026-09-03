import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerBacklogCommands } from './backlog';
import { registerRunCommands } from './run';
import { registerQACommands } from './qa';
import { registerLoopCommands } from './loop';

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
    expect(backlog?.commands.map(command => command.name())).toEqual(['init', 'list', 'show', 'create', 'tag']);
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

  it('exposes explicit agent selection on every execution command', () => {
    const run = commandTree(registerRunCommands).commands.find(command => command.name() === 'run');
    const loop = commandTree(registerLoopCommands).commands.find(command => command.name() === 'loop');
    const qa = commandTree(registerQACommands).commands.find(command => command.name() === 'qa');

    expect(run?.options.some(option => option.long === '--agent')).toBe(true);
    expect(loop?.options.some(option => option.long === '--agent')).toBe(true);
    expect(qa?.options.some(option => option.long === '--agent')).toBe(true);
  });

  it('exposes backlog creation relationship options', () => {
    const program = commandTree(registerBacklogCommands);
    const backlog = program.commands.find(command => command.name() === 'backlog');
    const create = backlog?.commands.find(command => command.name() === 'create');

    expect(create?.registeredArguments.map(argument => argument.name())).toEqual(['title']);
    expect(create?.options.map(option => option.long)).toEqual([
      '--description-file', '--parent', '--base-backlog', '--depends-on', '--mode', '--tag', '--project',
    ]);
    expect(create?.options.find(option => option.long === '--base-backlog')?.description).toContain('explicit execution base');
    expect(create?.options.find(option => option.long === '--depends-on')?.short).toBe('-d');
  });
});
