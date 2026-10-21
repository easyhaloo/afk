import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem, BacklogManagementProvider } from '@afk/application';
import {
  createBacklogService,
  type BacklogServiceDeps,
} from '../../desktop-client/electron/services/backlog-service';
import { COMMANDS } from '../../src/command-registry';
import { COMMANDS as CLI_COMMANDS } from '../../src/cli/command-registry';
import { registerBacklogCommands } from '../../src/cli/commands/backlog';import { inMemoryRuntimePorts } from '../support/runtime-ports.js';


// The stub answers the shared provider Port, so it is modelled with the
// shared `BacklogItem`. The desktop's own wire type is a structurally
// compatible projection of the same record.
function stubItem(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
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
    ...overrides,
  };
}

/**
 * One provider, shared by both entry points. The CLI resolves its provider
 * through `@afk/infrastructure`; the desktop resolves it through its own
 * composition root. Both end up at the same Port.
 */
const provider: BacklogManagementProvider = {
  get: vi.fn(async (id: string) => stubItem(id)),
  list: vi.fn(async (options) => {
    const items = [stubItem('42', { state: 'ready', tags: ['billing'] })];
    return options?.state ? items.filter(item => item.state === options.state) : items;
  }),
  create: vi.fn(async (input) => stubItem('new', { title: input.title })),
  addTag: vi.fn(async () => undefined),
  removeTag: vi.fn(async () => undefined),
  initialize: vi.fn(async () => undefined),
};

vi.mock('@afk/infrastructure', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/infrastructure')>(),
  createManagementProviders: vi.fn(async () => ({ backlog: provider, branches: {}, changes: {} })),
}));

function desktopService(): ReturnType<typeof createBacklogService> {
  const deps: BacklogServiceDeps = {
    providers: async () => provider,
    resolveWorkspace: (workspace: string) => workspace,
  };
  return createBacklogService(deps);
}

/** Run a CLI command and capture the JSON envelope it writes to stdout. */
async function runCli(args: string[]): Promise<{ ok: boolean; kind: string; data: unknown }> {
  const program = new Command().name('afk').exitOverride();
  registerBacklogCommands(program, { ports: inMemoryRuntimePorts() });
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await program.parseAsync(['node', 'afk', ...args]);
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(captured.join(''));
}

async function publicCommandTree(): Promise<Command> {
  const program = new Command().name('afk').exitOverride();
  for (const name of ['backlog', 'run', 'loop']) {
    const entry = COMMANDS.find(candidate => candidate.names.includes(name));
    expect(entry).toBeDefined();
    (await entry!.loader())(program, { ports: inMemoryRuntimePorts() });
  }
  return program;
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
    expect(run?.options.map(option => option.long)).not.toContain('--iid');
  });

  it('lists the same items in the CLI and the desktop', async () => {
    const envelope = await runCli(['backlog', 'list', '--state', 'ready', '--json']);
    const items = await desktopService().list('/workspace', { state: 'ready' });

    expect(envelope.kind).toBe('backlog.list');
    expect(envelope.data).toEqual(items);
  });

  it('shows the same item in the CLI and the desktop', async () => {
    const envelope = await runCli(['backlog', 'show', '--id', '42', '--json']);
    const item = await desktopService().show('/workspace', '42');

    expect(envelope.kind).toBe('backlog.show');
    expect(envelope.data).toEqual(item);
  });

  it('creates the same backlog in the CLI and the desktop', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'afk-contract-'));
    const descriptionFile = path.join(directory, 'description.md');
    await writeFile(descriptionFile, 'fresh', 'utf8');
    const envelope = await runCli(['backlog', 'create', 'fresh', '--description-file', descriptionFile, '--json']);
    const item = await desktopService().create('/workspace', { title: 'fresh', description: 'fresh' });
    await rm(directory, { recursive: true, force: true });

    expect(envelope.kind).toBe('backlog.create');
    expect(envelope.data).toEqual(item);
  });

  it('adds the same tag in the CLI and the desktop', async () => {
    const envelope = await runCli(['backlog', 'tag', 'add', '--id', '42', '--tag', 'urgent', '--json']);
    const item = await desktopService().addTag('/workspace', '42', 'urgent');

    expect(envelope.kind).toBe('backlog.tag.add');
    expect(envelope.data).toEqual(item);
  });

  it('removes the same tag in the CLI and the desktop', async () => {
    const envelope = await runCli(['backlog', 'tag', 'remove', '--id', '42', '--tag', 'urgent', '--json']);
    const item = await desktopService().removeTag('/workspace', '42', 'urgent');

    expect(envelope.kind).toBe('backlog.tag.remove');
    expect(envelope.data).toEqual(item);
  });
});
