import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildCommandArgv, COMMANDS, dispatchCommand } from './command-registry.js';

describe('CLI command registry and dispatcher', () => {
  it('exposes the canonical public command registry without duplicate routes', () => {
    const names = COMMANDS.flatMap(entry => entry.names);
    expect(names).toEqual(expect.arrayContaining([
      'signal',
      'tmux',
      'kanban',
      'debug',
      'isolate',
      'backlog',
      'run',
      'execute',
      'qa',
      'loop',
      'observe',
      'log',
      'retro',
      'graph',
      'completion',
      '__complete',
    ]));
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(['backlog', 'run', 'execute', 'loop', 'qa', 'observe', 'log', 'retro', 'graph', 'completion'])('loads the public %s command advertised by the registry', async name => {
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
    const adopt = backlog?.commands.filter(command => command.name() === 'adopt');
    const tag = backlog?.commands.find(command => command.name() === 'tag');

    expect(create).toHaveLength(1);
    expect(inventory).toHaveLength(1);
    expect(adopt).toHaveLength(1);
    expect(adopt?.[0]?.options.filter(option => option.mandatory).map(option => option.long)).toEqual([
      '--id', '--project', '--platform',
    ]);
    expect(adopt?.[0]?.options.find(option => option.long === '--platform')?.argChoices).toEqual(['github', 'gitlab']);
    expect(adopt?.[0]?.options.some(option => option.long === '--json')).toBe(true);
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

  it('builds argv for top-level and nested command parsing', () => {
    expect(buildCommandArgv('run', ['--backlog-id', '42'])).toEqual([
      'afk', 'run', '--backlog-id', '42',
    ]);
    expect(buildCommandArgv('backlog', ['tag', 'add', '--id', '42'], 'tag')).toEqual([
      'afk', 'tag', 'add', '--id', '42',
    ]);
  });

  it('fails unknown commands without loading the full command set', async () => {
    await expect(dispatchCommand('not-a-command', [])).rejects.toThrow(
      "Unknown command 'not-a-command'. Run 'afk --help' to see available commands.",
    );
  });

  it.each([
    ['backlog', ['tag', 'add', '--help'], 'Add a business tag'],
    ['backlog', ['tag', 'remove', '--help'], 'Remove a business tag'],
    ['observe', ['timeline', '--help'], 'Show ordered audit events for a run'],
    ['log', ['--help'], 'Show one observed run and its verified timeline'],
  ] as const)('runs the nested parser for %s %j', async (command, args, expectedHelp) => {
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      await expect(dispatchCommand(command, [...args])).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured.join('')).toContain(expectedHelp);
  });
});
