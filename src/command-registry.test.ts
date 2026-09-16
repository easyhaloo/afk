import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './command-registry';
import { COMMANDS as CLI_COMMANDS } from './cli/command-registry';
import { lazyLoad } from './lazy-loader';
import { lazyLoad as cliLazyLoad } from './cli/lazy-loader';
import { runFullCLI } from './full-cli';
import { runFullCLI as runCanonicalFullCLI } from './cli/full-cli';

describe('CLI hard cutover registry', () => {
  it('delegates the public registry to the canonical CLI registry', () => {
    expect(COMMANDS).toBe(CLI_COMMANDS);
    expect(lazyLoad).toBe(cliLazyLoad);
    expect(runFullCLI).toBe(runCanonicalFullCLI);

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

  it.each(['backlog', 'run', 'loop', 'qa'])('loads the public %s command advertised by the registry', async name => {
    const entry = COMMANDS.find(candidate => candidate.names.includes(name));
    expect(entry).toBeDefined();

    const program = new Command().name('afk').exitOverride();
    const register = await entry!.loader();
    register(program);

    expect(program.commands.map(command => command.name())).toContain(name);
  });

  it('exposes the canonical backlog and run command contract', async () => {
    const program = new Command().name('afk').exitOverride();
    const backlogEntry = COMMANDS.find(entry => entry.names.includes('backlog'))!;
    const runEntry = COMMANDS.find(entry => entry.names.includes('run'))!;
    (await backlogEntry.loader())(program);
    (await runEntry.loader())(program);

    const backlog = program.commands.find(command => command.name() === 'backlog');
    const run = program.commands.find(command => command.name() === 'run');
    const backlogNames = backlog?.commands.map(command => command.name()) ?? [];
    expect(backlogNames).toEqual(expect.arrayContaining(['init', 'list', 'show', 'create', 'tag']));
    expect(new Set(backlogNames).size).toBe(backlogNames.length);
    expect(backlog?.commands.filter(command => command.name() === 'create')).toHaveLength(1);
    expect(run?.options.find(option => option.long === '--backlog-id')).toMatchObject({ required: true });
    expect(run?.options.some(option => option.long === '--iid')).toBe(false);
  });
});
