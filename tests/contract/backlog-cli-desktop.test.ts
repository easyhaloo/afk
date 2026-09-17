import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { buildBacklogRunArgs } from '../../desktop-client/electron/services/backlog-execution-service';
import {
  createBacklogService,
  type BacklogExecResult,
  type BacklogServiceDeps,
} from '../../desktop-client/electron/services/backlog-service';
import type { BacklogItem } from '../../desktop-client/shared/backlog-contract';
import { COMMANDS } from '../../src/command-registry';
import { COMMANDS as CLI_COMMANDS } from '../../src/cli/command-registry';
import { registerBacklogCommands } from '../../src/cli/commands/backlog';
import { registerObserveCommands } from '../../src/cli/commands/observe';

function stubItem(id: string): BacklogItem {
  return {
    id,
    title: `task ${id}`,
    description: 'demo',
    dependsOn: [],
    state: 'ready',
    executionMode: 'afk',
    tags: [],
    branchName: `afk/backlog-${id}`,
    providerRef: `stub:${id}`,
  };
}

function success(kind: string, data: BacklogItem | BacklogItem[]): BacklogExecResult {
  return { ok: true, stdout: JSON.stringify({ ok: true, kind, data }), stderr: '' };
}

function makeDesktopService() {
  const execMock = vi.fn(async (_command: string, args: string[]) => {
    const operation = args.slice(0, 3).join(' ');
    if (operation === 'backlog tag add') return success('backlog.tag.add', stubItem('42'));
    if (operation === 'backlog tag remove') return success('backlog.tag.remove', stubItem('42'));
    if (args[1] === 'list') return success('backlog.list', [stubItem('42')]);
    if (args[1] === 'show') return success('backlog.show', stubItem('42'));
    return success('backlog.create', stubItem('new'));
  });
  const deps: BacklogServiceDeps = {
    resolveAfk: async () => '/usr/local/bin/afk',
    resolveWorkspace: workspace => workspace,
    exec: execMock,
  };
  return { service: createBacklogService(deps), execMock };
}

async function publicCommandTree(): Promise<Command> {
  const program = new Command().name('afk').exitOverride();
  for (const name of ['backlog', 'run', 'loop']) {
    const entry = COMMANDS.find(candidate => candidate.names.includes(name));
    expect(entry).toBeDefined();
    (await entry!.loader())(program);
  }
  return program;
}

function parseCanonicalHelp(args: string[]): string {
  const program = new Command().name('afk').exitOverride();
  registerBacklogCommands(program);
  registerObserveCommands(program);
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  let error: unknown;
  try {
    program.parse(['node', 'afk', ...args]);
  } catch (caught) {
    error = caught;
  } finally {
    process.stdout.write = originalWrite;
  }
  expect(error).toMatchObject({ code: 'commander.helpDisplayed', message: '(outputHelp)' });
  return captured.join('');
}

function optionNames(command: Command | undefined): string[] {
  return command?.options
    .map(option => option.long)
    .filter((name): name is string => name !== undefined) ?? [];
}

function flags(args: string[]): string[] {
  return args.filter(argument => argument.startsWith('--'));
}

function expectDesktopFlagsMatchPublicCommand(args: string[], command: Command | undefined): void {
  const desktopFlags = flags(args);
  const publicFlags = optionNames(command);
  expect(desktopFlags.every(flag => publicFlags.includes(flag))).toBe(true);
}

describe('Backlog public CLI/Desktop compatibility regression', () => {
  it('binds the contract to the backlog and run loaders used by the public CLI', async () => {
    expect(COMMANDS).toBe(CLI_COMMANDS);
    const program = await publicCommandTree();
    const backlog = program.commands.find(command => command.name() === 'backlog');
    const run = program.commands.find(command => command.name() === 'run');

    const backlogNames = backlog?.commands.map(command => command.name()) ?? [];
    expect(backlogNames).toEqual(expect.arrayContaining(['init', 'list', 'show', 'create', 'tag']));
    expect(new Set(backlogNames).size).toBe(backlogNames.length);
    expect(backlog?.commands.filter(command => command.name() === 'create')).toHaveLength(1);
    expect(run?.options.find(option => option.long === '--backlog-id')).toMatchObject({ required: true });
    expect(optionNames(run)).not.toContain('--iid');
  });

  it('matches Desktop list/show/tag argv to options supported by the public CLI', async () => {
    const program = await publicCommandTree();
    const backlog = program.commands.find(command => command.name() === 'backlog')!;
    const list = backlog.commands.find(command => command.name() === 'list');
    const show = backlog.commands.find(command => command.name() === 'show');
    const tag = backlog.commands.find(command => command.name() === 'tag');
    const addTag = tag?.commands.find(command => command.name() === 'add');
    const removeTag = tag?.commands.find(command => command.name() === 'remove');
    const { service, execMock } = makeDesktopService();

    await service.list('/workspace', { state: 'ready', executionMode: 'hitl', parentId: 'epic-7', tag: 'billing' });
    await service.show('/workspace', '42');
    await service.addTag('/workspace', '42', 'urgent');
    await service.removeTag('/workspace', '42', 'urgent');

    const [listArgs, showArgs, addTagArgs, removeTagArgs] = execMock.mock.calls.map(call => call[1] as string[]);
    expectDesktopFlagsMatchPublicCommand(listArgs, list);
    expectDesktopFlagsMatchPublicCommand(showArgs, show);
    expectDesktopFlagsMatchPublicCommand(addTagArgs, addTag);
    expectDesktopFlagsMatchPublicCommand(removeTagArgs, removeTag);
  });

  it('supports Desktop backlog list platform selection in the public CLI', async () => {
    const program = await publicCommandTree();
    const backlog = program.commands.find(command => command.name() === 'backlog')!;
    const list = backlog.commands.find(command => command.name() === 'list');
    const { service, execMock } = makeDesktopService();

    await service.list('/workspace', { platform: 'github' });

    const listArgs = execMock.mock.calls[0][1] as string[];
    expect(listArgs).toEqual(['backlog', 'list', '--platform', 'github', '--json']);
    expect(optionNames(list)).toEqual(expect.arrayContaining(['--platform', '--json']));
  });

  it('supports Desktop create and JSON output in the public CLI', async () => {
    const program = await publicCommandTree();
    const backlog = program.commands.find(command => command.name() === 'backlog')!;
    const list = backlog.commands.find(command => command.name() === 'list');
    const show = backlog.commands.find(command => command.name() === 'show');
    const create = backlog.commands.find(command => command.name() === 'create');
    const tag = backlog.commands.find(command => command.name() === 'tag');
    const addTag = tag?.commands.find(command => command.name() === 'add');
    const { service, execMock } = makeDesktopService();

    await service.list('/workspace');
    await service.show('/workspace', '42');
    await service.create('/workspace', { title: 'fresh', description: 'demo' });
    await service.addTag('/workspace', '42', 'urgent');

    const desktopArgs = execMock.mock.calls.map(call => call[1] as string[]);
    expect(backlog.commands.filter(command => command.name() === 'create')).toHaveLength(1);
    expect(desktopArgs.find(args => args[1] === 'create')).toEqual([
      'backlog',
      'create',
      'fresh',
      '--description-file',
      expect.stringMatching(/afk-backlog-.*\/description\.md$/),
      '--json',
    ]);
    expect(desktopArgs.every(args => args.at(-1) === '--json')).toBe(true);
    expectDesktopFlagsMatchPublicCommand(desktopArgs[0], list);
    expectDesktopFlagsMatchPublicCommand(desktopArgs[1], show);
    expectDesktopFlagsMatchPublicCommand(desktopArgs[2], create);
    expectDesktopFlagsMatchPublicCommand(desktopArgs[3], addTag);
  });

  it('keeps Desktop run assembly aligned with the public scoped loop command', async () => {
    const program = await publicCommandTree();
    const loop = program.commands.find(command => command.name() === 'loop');
    const args = buildBacklogRunArgs({ backlogId: 'feature/auth', template: 'feature-delivery' });

    expect(args).toEqual(['loop', '--backlog-id', 'feature/auth', '--max-iterations', '1', '--template', 'feature-delivery']);
    expect(flags(args)).toEqual(['--backlog-id', '--max-iterations', '--template']);
    expect(optionNames(loop)).toEqual(expect.arrayContaining(flags(args)));
  });

  it.each([
    [['backlog', 'tag', 'add', '--help'], 'Add a business tag'],
    [['backlog', 'tag', 'remove', '--help'], 'Remove a business tag'],
    [['observe', 'timeline', '--help'], 'Show ordered audit events for a run'],
  ] as const)('routes canonical nested parser %j to the intended command', (args, expectedHelp) => {
    expect(parseCanonicalHelp([...args])).toContain(expectedHelp);
  });

  it('emits one JSON failure without CommanderError text for missing required options', () => {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', 'src/index.ts', 'backlog', 'show', '--json',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      kind: 'backlog.show',
      error: { code: 'validation', message: expect.stringMatching(/required option/i) },
    });
    expect(result.stderr).not.toMatch(/CommanderError|commander\.missingMandatoryOptionValue|at .*src\/index/);
    expect(result.stderr).not.toMatch(/required option .* not specified/i);
  });
});
