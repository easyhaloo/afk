import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerBacklogCommands, runBacklogList, runBacklogShow, runBacklogCreate, runBacklogTagAdd, runBacklogTagRemove } from './backlog';
import { registerRunCommands } from './run';
import { registerQACommands } from './qa';
import { registerLoopCommands } from './loop';
import type { BacklogItem, BacklogManagementProvider } from '../../domain/backlog';
import { emitSuccess, emitFailure } from '../json-output';

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
      '--description-file', '--parent', '--base-backlog', '--depends-on', '--mode', '--tag', '--project', '--platform', '--json',
    ]);
    expect(create?.options.find(option => option.long === '--base-backlog')?.description).toContain('explicit execution base');
    expect(create?.options.find(option => option.long === '--depends-on')?.short).toBe('-d');
  });

  it('exposes --json and --platform on every backlog read/write subcommand', () => {
    const program = commandTree(registerBacklogCommands);
    const backlog = program.commands.find(command => command.name() === 'backlog');
    expect(backlog).toBeDefined();
    for (const name of ['list', 'show', 'init']) {
      const command = backlog!.commands.find(cmd => cmd.name() === name);
      expect(command?.options.some(option => option.long === '--json'), `${name} --json`).toBe(true);
      expect(command?.options.some(option => option.long === '--platform'), `${name} --platform`).toBe(true);
    }
    const tagAdd = backlog!.commands.find(cmd => cmd.name() === 'tag')!.commands.find(cmd => cmd.name() === 'add');
    const tagRemove = backlog!.commands.find(cmd => cmd.name() === 'tag')!.commands.find(cmd => cmd.name() === 'remove');
    expect(tagAdd?.options.some(option => option.long === '--json')).toBe(true);
    expect(tagAdd?.options.some(option => option.long === '--platform')).toBe(true);
    expect(tagRemove?.options.some(option => option.long === '--json')).toBe(true);
    expect(tagRemove?.options.some(option => option.long === '--platform')).toBe(true);
  });
});

describe('json-output helpers', () => {
  it('emitSuccess writes the structured success envelope to stdout', () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      emitSuccess('backlog.list', [{ id: '1' }]);
    } finally {
      process.stdout.write = original;
    }
    expect(JSON.parse(captured.join(''))).toEqual({ ok: true, kind: 'backlog.list', data: [{ id: '1' }] });
  });

  it('emitFailure writes the structured failure envelope and exits 1', () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
    try {
      expect(() => emitFailure('backlog.list', 'auth', 'missing token', { hint: 'set GITHUB_TOKEN' })).toThrow('__exit__:1');
    } finally {
      process.stdout.write = original;
      exitSpy.mockRestore();
    }
    expect(JSON.parse(captured.join(''))).toEqual({
      ok: false,
      kind: 'backlog.list',
      error: { code: 'auth', message: 'missing token', details: { hint: 'set GITHUB_TOKEN' } },
    });
  });
});

function stubProvider(items: BacklogItem[], overrides: Partial<BacklogManagementProvider> = {}): BacklogManagementProvider {
  return {
    async list() { return items; },
    async get(id: string) {
      const found = items.find(item => item.id === id);
      if (!found) throw new Error(`backlog ${id} not found`);
      return found;
    },
    async create(input) {
      const created: BacklogItem = {
        id: 'new-1', title: input.title, description: input.description,
        parentId: input.parentId, baseBacklogId: input.baseBacklogId,
        dependsOn: [...(input.dependsOn ?? [])],
        state: 'ready',
        executionMode: input.executionMode ?? 'afk',
        tags: [...(input.tags ?? [])],
        branchName: 'afk/backlog-new-1', providerRef: 'stub:new-1',
      };
      return created;
    },
    async addTag(id: string, tag: string) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      if (!item.tags.includes(tag)) item.tags.push(tag);
    },
    async removeTag(id: string, tag: string) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      item.tags = item.tags.filter(existing => existing !== tag);
    },
    async initialize() { /* noop */ },
    ...overrides,
  };
}

const stubItem: BacklogItem = {
  id: '42', title: 'demo task', description: 'demo body',
  parentId: undefined, baseBacklogId: undefined, dependsOn: [],
  state: 'ready', executionMode: 'afk', tags: ['billing'],
  branchName: 'afk/backlog-42', providerRef: 'stub:42', webUrl: 'https://example/42',
};

describe('backlog action handlers (JSON envelope mode)', () => {
  it('runBacklogList returns the structured success envelope when --json is set', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogList(stubProvider([stubItem]), { json: true });
    } finally {
      process.stdout.write = original;
    }
    expect(JSON.parse(captured.join(''))).toEqual({
      ok: true, kind: 'backlog.list', data: [stubItem],
    });
  });

  it('runBacklogList returns the structured failure envelope when the provider throws', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
    try {
      await expect(runBacklogList(
        stubProvider([], { async list() { throw new Error('authentication required: GITHUB_TOKEN not set'); } }),
        { json: true },
      )).rejects.toThrow('__exit__:1');
    } finally {
      process.stdout.write = original;
      exitSpy.mockRestore();
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(false);
    expect(envelope.kind).toBe('backlog.list');
    expect(envelope.error.code).toBe('auth');
    expect(envelope.error.message).toContain('authentication');
  });

  it('runBacklogShow emits the success envelope', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogShow(stubProvider([stubItem]), '42', { json: true });
    } finally {
      process.stdout.write = original;
    }
    expect(JSON.parse(captured.join(''))).toEqual({
      ok: true, kind: 'backlog.show', data: stubItem,
    });
  });

  it('runBacklogCreate emits the success envelope with the new item', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogCreate(stubProvider([]), { title: 'fresh', description: 'desc', json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.create');
    expect(envelope.data.id).toBe('new-1');
    expect(envelope.data.title).toBe('fresh');
  });

  it('runBacklogTagAdd emits the success envelope with the updated item', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogTagAdd(stubProvider([{ ...stubItem, tags: ['billing'] }]), '42', 'urgent', { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.tag.add');
    expect(envelope.data.tags).toContain('urgent');
  });

  it('runBacklogTagRemove emits the success envelope with the updated item', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogTagRemove(stubProvider([{ ...stubItem, tags: ['billing', 'urgent'] }]), '42', 'urgent', { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.tag.remove');
    expect(envelope.data.tags).not.toContain('urgent');
  });
});
