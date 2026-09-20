import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './command-registry';

describe('CLI hard cutover registry', () => {
  it('exposes the canonical public command registry without duplicate routes', () => {
    const names = COMMANDS.flatMap(entry => entry.names);
    expect(names).toEqual(expect.arrayContaining([
      'signal',
      'tmux',
      'board',
      'kanban',
      'debug',
      'isolate',
      'backlog',
      'run',
      'qa',
      'loop',
      'observe',
      'graph',
      'completion',
      '__complete',
    ]));
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(['backlog', 'run', 'loop', 'qa', 'observe', 'graph', 'completion'])('loads the public %s command advertised by the registry', async name => {
    const entry = COMMANDS.find(candidate => candidate.names.includes(name));
    expect(entry).toBeDefined();

    const program = new Command().name('afk').exitOverride();
    const register = await entry!.loader();
    register(program);

    expect(program.commands.map(command => command.name())).toContain(name);
  });

  it('registers backlog create and nested tag commands exactly once', async () => {
    const backlogEntry = COMMANDS.find(entry => entry.names.includes('backlog'))!;
    const registerBacklog = await backlogEntry.loader();
    const program = new Command().name('afk').exitOverride();
    registerBacklog(program);

    const backlog = program.commands.find(command => command.name() === 'backlog');
    const create = backlog?.commands.filter(command => command.name() === 'create');
    const inventory = backlog?.commands.filter(command => command.name() === 'inventory');
    const tag = backlog?.commands.find(command => command.name() === 'tag');

    expect(create).toHaveLength(1);
    expect(inventory).toHaveLength(1);
    expect(inventory?.[0]?.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--platform', '--state', '--mode', '--tag', '--project', '--json',
    ]));
    expect(create?.[0]?.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--description-file', '--parent', '--base-backlog', '--depends-on', '--mode', '--tag', '--project', '--platform', '--json',
    ]));
    const tagNames = tag?.commands.map(command => command.name()) ?? [];
    expect(tagNames).toEqual(expect.arrayContaining(['add', 'remove']));
    expect(new Set(tagNames).size).toBe(tagNames.length);
  });

  it('characterizes the current run command contract', async () => {
    const program = new Command().name('afk').exitOverride();
    const runEntry = COMMANDS.find(entry => entry.names.includes('run'))!;
    (await runEntry.loader())(program);

    const run = program.commands.find(command => command.name() === 'run');
    expect(run?.options.find(option => option.long === '--backlog-id')).toMatchObject({ required: true });
    expect(run?.options.some(option => option.long === '--iid')).toBe(false);
  });
});
