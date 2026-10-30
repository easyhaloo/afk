import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerBacklogCommands,
  runBacklogAdopt,
  runBacklogConfirmMerge,
  runBacklogCreate,
  runBacklogChildren,
  resolveBacklogChildrenIdentity,
  runBacklogInterrupt,
  runBacklogInventory,
  runBacklogList,
  runBacklogRelationAdd,
  runBacklogRelationRemove,
  runBacklogRetry,
  runBacklogRole,
  runBacklogExecutionBase,
  runBacklogMode,
  runBacklogShow,
  runBacklogTagAdd,
  runBacklogTagRemove,
} from './backlog.js';
import { registerRunCommands } from './run.js';
import { registerQACommands } from './qa.js';
import { registerLoopCommands } from './loop.js';
import type { BacklogCreateInput, BacklogExecutionMode, BacklogItem, BacklogKind, BacklogRelationUpdate, QABacklogProvider } from '@afk/runtime/domain/backlog/index';
import { planBacklogCreate } from '@afk/runtime/domain/backlog/commands';
import type { ProviderCatalog } from '@afk/runtime/domain/work-item/provider-types';
import type { GlobalWorkItem } from '@afk/runtime/domain/work-item/types';
import { emitSuccess, emitFailure } from '../output.js';
import * as providerFactory from '@afk/runtime/infrastructure/provider/tracker-provider-factory';

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
    const commandNames = backlog?.commands.map(command => command.name()) ?? [];
    expect(commandNames).toEqual(expect.arrayContaining([
      'init', 'adopt', 'inventory', 'list', 'show', 'children', 'create', 'interrupt', 'retry', 'confirm-merge', 'tag',
    ]));
    expect(new Set(commandNames).size).toBe(commandNames.length);
    const tagNames = backlog?.commands.find(command => command.name() === 'tag')?.commands.map(command => command.name()) ?? [];
    expect(tagNames).toEqual(expect.arrayContaining(['add', 'remove']));
    expect(new Set(tagNames).size).toBe(tagNames.length);
  });

  it('exposes global inventory filters without changing backlog list options', () => {
    const program = commandTree(registerBacklogCommands);
    const backlog = program.commands.find(command => command.name() === 'backlog')!;
    const inventory = backlog.commands.find(command => command.name() === 'inventory')!;
    const list = backlog.commands.find(command => command.name() === 'list')!;

    expect(inventory.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--platform', '--state', '--mode', '--tag', '--project', '--json',
    ]));
    expect(list.options.some(option => option.long === '--parent')).toBe(true);
    expect(list.options.map(option => option.long)).not.toContain('--all-projects');
  });

  it('requires a string backlog id for run and qa', () => {
    const run = commandTree(registerRunCommands).commands.find(command => command.name() === 'run');
    const qa = commandTree(registerQACommands).commands.find(command => command.name() === 'qa');
    expect(run?.options.some(option => option.long === '--backlog-id' && option.required)).toBe(true);
    expect(qa?.options.some(option => option.long === '--backlog-id' && option.required)).toBe(true);
    expect(run?.options.some(option => option.long === '--iid')).toBe(false);
    expect(qa?.options.some(option => option.long === '--iid')).toBe(false);
  });

  it('keeps agent selection on lower-level commands and binds loop to a manifest', () => {
    const run = commandTree(registerRunCommands).commands.find(command => command.name() === 'run');
    const loop = commandTree(registerLoopCommands).commands.find(command => command.name() === 'loop');
    const qa = commandTree(registerQACommands).commands.find(command => command.name() === 'qa');

    expect(run?.options.some(option => option.long === '--agent')).toBe(true);
    expect(loop?.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--backlog-id', '--work-item-id', '--execution-manifest',
    ]));
    expect(loop?.options.some(option => option.long === '--agent')).toBe(false);
    expect(qa?.options.some(option => option.long === '--agent')).toBe(true);
  });

  it('exposes backlog creation relationship options', () => {
    const program = commandTree(registerBacklogCommands);
    const backlog = program.commands.find(command => command.name() === 'backlog');
    const create = backlog?.commands.find(command => command.name() === 'create');

    expect(create?.registeredArguments.map(argument => argument.name())).toEqual(['title']);
    expect(create?.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--description-file', '--parent', '--base-backlog', '--depends-on', '--mode', '--kind', '--dry-run', '--idempotency-key', '--tag', '--project', '--platform', '--json',
    ]));
    // The stage option is gone: a PRD is a role, not a lifecycle position.
    expect(create?.options.map(option => option.long)).not.toContain('--stage');
    expect(create?.options.find(option => option.long === '--base-backlog')?.description).toContain('explicit execution base');
    expect(create?.options.find(option => option.long === '--depends-on')?.short).toBe('-d');
  });

  it('exposes --json and --platform on every backlog read/write subcommand', () => {
    const program = commandTree(registerBacklogCommands);
    const backlog = program.commands.find(command => command.name() === 'backlog');
    expect(backlog).toBeDefined();
    for (const name of ['list', 'show', 'init', 'interrupt', 'retry', 'confirm-merge']) {
      const command = backlog!.commands.find(cmd => cmd.name() === name);
      expect(command?.options.some(option => option.long === '--json'), `${name} --json`).toBe(true);
      expect(command?.options.some(option => option.long === '--platform'), `${name} --platform`).toBe(true);
    }
    for (const name of ['interrupt', 'retry']) {
      const command = backlog!.commands.find(cmd => cmd.name() === name);
      expect(command?.options.some(option => option.long === '--id' && option.required), `${name} --id`).toBe(true);
      expect(command?.options.some(option => option.long === '--reason' && option.required), `${name} --reason`).toBe(true);
    }
    const confirmMerge = backlog!.commands.find(cmd => cmd.name() === 'confirm-merge');
    expect(confirmMerge?.options.some(option => option.long === '--id' && option.required)).toBe(true);
    const reconcileMerge = backlog!.commands.find(cmd => cmd.name() === 'reconcile-merge');
    expect(reconcileMerge?.options.some(option => option.long === '--id' && option.required)).toBe(true);
    expect(reconcileMerge?.options.some(option => option.long === '--json')).toBe(true);
    const tagAdd = backlog!.commands.find(cmd => cmd.name() === 'tag')!.commands.find(cmd => cmd.name() === 'add');
    const tagRemove = backlog!.commands.find(cmd => cmd.name() === 'tag')!.commands.find(cmd => cmd.name() === 'remove');
    expect(tagAdd?.options.some(option => option.long === '--json')).toBe(true);
    expect(tagAdd?.options.some(option => option.long === '--platform')).toBe(true);
    expect(tagRemove?.options.some(option => option.long === '--json')).toBe(true);
    expect(tagRemove?.options.some(option => option.long === '--platform')).toBe(true);
  });
});

describe('explicit backlog adoption', () => {
  it.each(['github', 'gitlab'])('uses the explicit %s project and emits one adoption envelope', async platform => {
    const item: BacklogItem = {
      id: '42', title: 'Manual issue', state: 'ready', executionMode: 'afk',
      tags: ['feature'], dependsOn: [], branchName: 'afk/backlog-42', providerRef: `${platform}:org/repo#42`,
    };
    const adopt = vi.fn().mockResolvedValue(item);
    const factory = vi.spyOn(providerFactory, 'createManagementProviders').mockResolvedValue({
      backlog: stubProvider([], { adopt }),
    } as Awaited<ReturnType<typeof providerFactory.createManagementProviders>>);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await commandTree(registerBacklogCommands).parseAsync([
        'node', 'afk', 'backlog', 'adopt', '--id', '42', '--project', 'org/repo', '--platform', platform, '--json',
      ]);
      expect(factory).toHaveBeenCalledWith('org/repo', process.cwd(), platform, undefined);
      expect(adopt).toHaveBeenCalledWith('42');
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({ ok: true, kind: 'backlog.adopt', data: item });
    } finally {
      factory.mockRestore();
      stdout.mockRestore();
    }
  });

  it.each([
    ['--project', 'org/repo', '--platform', 'github'],
    ['--id', '42', '--platform', 'github'],
    ['--id', '42', '--project', 'org/repo'],
    ['--id', '42', '--project', 'org/repo', '--platform', 'all'],
  ])('rejects invalid or missing adoption scope before provider creation: %j', async flags => {
    const argv = ['node', 'afk', 'backlog', 'adopt', ...flags, '--json'];
    const program = new Command().name('afk').exitOverride();
    registerBacklogCommands(program, { argv });
    const factory = vi.spyOn(providerFactory, 'createManagementProviders');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previousExitCode = process.exitCode;
    try {
      await expect(program.parseAsync(argv)).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
        ok: false, kind: 'backlog.adopt', error: { code: 'validation' },
      });
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      factory.mockRestore();
    }
  });

  it('emits one JSON failure when adoption is unsupported', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previousExitCode = process.exitCode;
    try {
      await runBacklogAdopt(stubProvider([]), '42', { json: true });
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
        ok: false, kind: 'backlog.adopt', error: { message: expect.stringContaining('does not support explicit issue adoption') },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
    }
  });
});

describe('backlog inventory command', () => {
  const managedLabels = ['stage::ready-for-issues', 'mode::afk', 'team::api'];

  function inventoryCatalog(): ProviderCatalog {
    return {
      platform: 'github',
      scopeKey: 'github.com',
      async listProjects() {
        return [
          { platform: 'github', projectKey: 'acme/api', name: 'api' },
          { platform: 'github', projectKey: 'acme/web', name: 'web' },
        ];
      },
      async listIssues(project) {
        if (project.projectKey === 'acme/api') {
          return [
            { issueNumber: 1, title: 'matching', labels: managedLabels, state: 'opened' },
            { issueNumber: 2, title: 'wrong mode', labels: ['stage::ready-for-issues', 'mode::hitl', 'team::api'], state: 'opened' },
          ];
        }
        return [{ issueNumber: 1, title: 'wrong project', labels: managedLabels, state: 'opened' }];
      },
    };
  }

  it('emits the backlog.inventory envelope with combined filters', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogInventory(
        platform => {
          expect(platform).toBe('github');
          return [inventoryCatalog()];
        },
        { platform: 'github', state: 'ready', mode: 'afk', tag: 'team::api', project: 'acme/api', json: true },
      );
    } finally {
      process.stdout.write = original;
    }

    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: true,
      kind: 'backlog.inventory',
      data: {
        complete: true,
        projects: [{ projectKey: 'acme/api' }],
        diagnostics: [],
        items: [{ id: 'github:acme/api#1', title: 'matching' }],
      },
    });
  });

  it('emits a successful empty inventory', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogInventory(() => [{
        platform: 'github',
        scopeKey: 'github.com',
        async listProjects() { return []; },
        async listIssues() { return []; },
      }], { json: true });
    } finally {
      process.stdout.write = original;
    }

    expect(JSON.parse(captured.join(''))).toEqual({
      ok: true,
      kind: 'backlog.inventory',
      data: { items: [], projects: [], diagnostics: [], complete: true },
    });
  });

  it('keeps the collected inventory when an account cannot be verified', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogInventory(() => [{
        ...inventoryCatalog(),
        getAccountIdentity: async () => { throw new Error('GitLab API HTTP 500: Internal Server Error'); },
      }], { json: true }, { root: await mkdtemp(join(tmpdir(), 'afk-inventory-unverified-')) });
    } finally {
      process.stdout.write = original;
    }

    const envelope = JSON.parse(captured.join(''));
    expect(envelope).toMatchObject({
      ok: true,
      kind: 'backlog.inventory',
      data: {
        complete: false,
        diagnostics: [{
          platform: 'github',
          projectKey: 'github.com',
          code: 'inventory_identity_unverified',
          message: 'GitLab API HTTP 500: Internal Server Error',
        }],
      },
    });
    // The inventory itself survives a publish failure.
    expect(envelope.data.items).toHaveLength(3);
  });

  it('publishes the inventory to the local mirror when every account is verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-inventory-published-'));
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogInventory(() => [{
        ...inventoryCatalog(),
        getAccountIdentity: async () => ({ platform: 'github' as const, host: 'github.com', accountId: '123' }),
      }], { json: true }, { root });
    } finally {
      process.stdout.write = original;
    }

    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: true,
      data: { complete: true, diagnostics: [] },
    });
    const published = await readdir(join(root, 'inventory'));
    expect(published.filter(name => name.endsWith('.sqlite'))).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });

  it('emits an auth failure when catalog credentials are missing', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const previousExitCode = process.exitCode;
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    process.exitCode = undefined;
    try {
      await runBacklogInventory(() => {
        throw new Error('GitHub authentication is required. Set GITHUB_TOKEN.');
      }, { platform: 'github', json: true });
      expect(process.exitCode).toBe(1);
    } finally {
      process.stdout.write = original;
      process.exitCode = previousExitCode;
    }

    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: false,
      kind: 'backlog.inventory',
      error: { code: 'auth' },
    });
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

  it('emitFailure writes the complete envelope and sets exitCode without immediate process exit', () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    const exitSpy = vi.spyOn(process, 'exit');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      expect(() => emitFailure('backlog.list', 'auth', 'missing token', { hint: 'set GITHUB_TOKEN' })).not.toThrow();
    } finally {
      process.stdout.write = original;
      exitSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(previousExitCode);
    expect(JSON.parse(captured.join(''))).toEqual({
      ok: false,
      kind: 'backlog.list',
      data: null,
      error: { code: 'auth', message: 'missing token', details: { hint: 'set GITHUB_TOKEN' } },
    });
  });

  it('emits one JSON envelope when Commander rejects a missing required backlog option', () => {
    const program = new Command().name('afk').exitOverride();
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalError = process.stderr.write.bind(process.stderr);
    const previousExitCode = process.exitCode;
    registerBacklogCommands(program, { argv: ['node', 'afk', 'backlog', 'show', '--json'] });
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.exitCode = undefined;
    try {
      expect(() => program.parse(['node', 'afk', 'backlog', 'show', '--json'])).toThrow(/required option/i);
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalError;
      process.exitCode = previousExitCode;
    }
    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: false,
      kind: 'backlog.show',
      error: { code: 'validation', message: expect.stringMatching(/required option/i) },
    });
  });
});

function stubProvider(items: BacklogItem[], overrides: Partial<QABacklogProvider> = {}): QABacklogProvider {
  return {
    // The provider owns the project a bare relationship reference resolves
    // against, so the plan can canonicalize it — exactly like a real one.
    async planCreate(input: BacklogCreateInput) {
      return planBacklogCreate({ get: async (id: string) => {
        const found = items.find(item => item.id === id || item.issueNumber === Number(id.slice(id.lastIndexOf('#') + 1)));
        if (!found) throw new Error(`backlog ${id} not found`);
        return found;
      } }, input, { platform: 'github', projectKey: 'org/repo' });
    },
    async list() { return items; },
    async get(id: string) {
      // A canonical global identity names the same issue as its number.
      const issueNumber = Number(id.slice(id.lastIndexOf('#') + 1));
      const found = items.find(item => item.id === id || item.issueNumber === issueNumber);
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
    async applyRelationUpdate(id: string, update: BacklogRelationUpdate) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      if (update.parent !== undefined) item.parentId = update.parent;
      if (update.clearParent) item.parentId = undefined;
      if (update.base !== undefined) item.baseBacklogId = update.base;
      if (update.clearBase) item.baseBacklogId = undefined;
      for (const dependency of update.addDependsOn ?? []) {
        if (!item.dependsOn.includes(dependency)) item.dependsOn.push(dependency);
      }
      for (const dependency of update.removeDependsOn ?? []) {
        item.dependsOn = item.dependsOn.filter(existing => existing !== dependency);
      }
    },
    async applyRole(id: string, kind: BacklogKind) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      item.kind = kind;
      delete item.state;
      item.executionMode = 'hitl';
    },
    async applyMode(id: string, mode: BacklogExecutionMode) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      item.executionMode = mode;
    },
    async initialize() { /* noop */ },
    async transition(id, state) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      item.state = state;
      if (state === 'blocked') item.executionMode = 'hitl';
    },
    async setExecutionMode(id, mode) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      item.executionMode = mode;
    },
    async createRework(id, input) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) throw new Error(`backlog ${id} not found`);
      item.state = 'rework';
      item.executionMode = 'afk';
      return {
        ...input,
        version: 1,
        id: 'r1',
        attempt: 1,
        status: 'open',
        createdAt: '2026-09-17T00:00:00.000Z',
      };
    },
    async getActiveRework() { return undefined; },
    async resolveRework() { /* noop */ },
    ...overrides,
  };
}

const stubItem: BacklogItem = {
  id: '42', issueNumber: 42, title: 'demo task', description: 'demo body',
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

  it('runBacklogList filters by role and rejects an unknown role', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const previousExitCode = process.exitCode;
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    let received: unknown;
    try {
      await runBacklogList(stubProvider([stubItem], {
        async list(options) { received = options; return []; },
      }), { kind: 'prd', json: true });
      // The role filter reaches the provider, so a PRD anchor is selectable
      // even though it has no lifecycle state to filter on.
      expect(received).toMatchObject({ kind: 'prd' });

      captured.length = 0;
      await runBacklogList(stubProvider([stubItem]), { kind: 'nope', json: true });
      const failure = JSON.parse(captured.join(''));
      expect(failure.error.message).toContain('invalid backlog role');
    } finally {
      process.stdout.write = original;
      process.exitCode = previousExitCode;
    }
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
      )).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
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

  it('passes canonical cross-project execution-base and dependency references through the CLI', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    const create = vi.fn(async (input: BacklogCreateInput) => ({
      ...stubItem,
      id: 'github:org/service#88',
      providerRef: 'github:org/service#88',
      baseBacklogId: input.baseBacklogId,
      dependsOn: [...(input.dependsOn ?? [])],
    }));
    try {
      await runBacklogCreate(stubProvider([], { create }), {
        title: 'Cross-repository implementation',
        description: 'Implement the API consumer',
        project: 'org/service',
        platform: 'github',
        baseBacklog: 'github:org/platform#17',
        dependsOn: ['github:org/platform#17'],
        idempotencyKey: 'prd-42/service-implementation',
        json: true,
      });
    } finally {
      process.stdout.write = original;
    }

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Cross-repository implementation',
      baseBacklogId: 'github:org/platform#17',
      dependsOn: ['github:org/platform#17'],
      idempotencyKey: 'prd-42/service-implementation',
    }));
    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: true,
      kind: 'backlog.create',
      data: {
        id: 'github:org/service#88',
        baseBacklogId: 'github:org/platform#17',
        dependsOn: ['github:org/platform#17'],
      },
    });
  });

  it('previews a PRD anchor and relationship labels without creating or initializing', async () => {
    const create = vi.fn();
    const initialize = vi.fn();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runBacklogCreate(stubProvider([stubItem], { create, initialize }), {
        title: 'PRD', description: 'Body', kind: 'prd', dryRun: true, parent: '42', json: true,
      });
      const envelope = JSON.parse(String(output.mock.calls[0][0]));
      expect(envelope).toMatchObject({ ok: true, kind: 'backlog.create',
        data: { dryRun: true, title: 'PRD', kind: 'prd',
          labels: ['kind::prd', 'mode::hitl', 'parent::github:org/repo#42'] } });
      // A PRD anchor has no lifecycle position, so the plan carries no state.
      expect(envelope.data.state).toBeUndefined();
      expect(create).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
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

  it('runBacklogRelationAdd emits the success envelope with the updated item', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogRelationAdd(stubProvider([{ ...stubItem }]), '42', { parent: 'github:org/repo#7', json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.relation.add');
    expect(envelope.data.parentId).toBe('github:org/repo#7');
  });

  it('runBacklogRelationRemove drops the edge it was asked to drop', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogRelationRemove(
        stubProvider([{ ...stubItem, parentId: 'github:org/repo#7', dependsOn: ['github:org/repo#9'] }]),
        '42',
        { parent: true, json: true },
      );
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.relation.remove');
    expect(envelope.data.parentId).toBeUndefined();
    expect(envelope.data.dependsOn).toEqual(['github:org/repo#9']);
  });

  it('runBacklogRelationAdd refuses an edit that names no edge', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogRelationAdd(stubProvider([{ ...stubItem }]), '42', { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(false);
    expect(envelope.kind).toBe('backlog.relation.add');
    expect(envelope.error.message).toMatch(/nothing to add/);
  });

  it('runBacklogRole turns an item into an anchor', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogRole(stubProvider([{ ...stubItem }]), '42', 'prd', { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.role');
    expect(envelope.data.kind).toBe('prd');
    expect(envelope.data.state).toBeUndefined();
    expect(envelope.data.executionMode).toBe('hitl');
  });

  it('runBacklogRole refuses a role the model does not have', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogRole(stubProvider([{ ...stubItem }]), '42', 'nope' as BacklogKind, { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(false);
    expect(envelope.kind).toBe('backlog.role');
    expect(envelope.error.message).toContain('invalid backlog role');
  });

  it('runBacklogExecutionBase records the ref the work starts from', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    const applied: string[] = [];
    const provider = stubProvider([stubItem], {
      async applyExecutionBase(id: string, baseBranch: string) {
        applied.push(`${id}=${baseBranch}`);
      },
    });
    try {
      await runBacklogExecutionBase(provider, '42', '2025-11-8-show', { json: true });
    } finally {
      process.stdout.write = original;
    }
    expect(applied).toEqual(['42=2025-11-8-show']);
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.base');
  });

  it('runBacklogExecutionBase refuses an empty ref', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogExecutionBase(stubProvider([stubItem]), '42', '  ', { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toMatch(/branch is required/i);
  });

  it('runBacklogCreate declares the base ref in the body', async () => {
    const created: BacklogCreateInput[] = [];
    const provider = {
      ...stubProvider([stubItem]),
      async create(input: BacklogCreateInput): Promise<BacklogItem> {
        created.push(input);
        return { ...stubItem, id: 'new-1', title: input.title, description: input.description };
      },
    };
    await runBacklogCreate(provider, { title: 'demo', description: '## Context\n\nbody', baseBranch: 'release-1' });

    expect(created).toHaveLength(1);
    expect(created[0].description).toContain('## Base Version');
    expect(created[0].description).toContain('- Base Ref: release-1');
  });

  it('runBacklogMode switches who runs an item', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogMode(stubProvider([{ ...stubItem }]), '42', 'afk', { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe('backlog.mode');
    expect(envelope.data.executionMode).toBe('afk');
    expect(envelope.data.state).toBe('ready');
  });

  it('runBacklogMode refuses a mode the model does not have', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogMode(stubProvider([{ ...stubItem }]), '42', 'nope' as BacklogExecutionMode, { json: true });
    } finally {
      process.stdout.write = original;
    }
    const envelope = JSON.parse(captured.join(''));
    expect(envelope.ok).toBe(false);
    expect(envelope.kind).toBe('backlog.mode');
    expect(envelope.error.message).toContain('invalid execution mode');
  });

  it('runBacklogInterrupt emits the blocked hitl backlog', async () => {    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogInterrupt(
        stubProvider([{ ...stubItem, state: 'in_progress', executionMode: 'afk' }]),
        '42',
        'operator stop',
        { json: true },
      );
    } finally {
      process.stdout.write = original;
    }
    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: true,
      kind: 'backlog.interrupt',
      data: { id: '42', state: 'blocked', executionMode: 'hitl' },
    });
  });

  it('runBacklogRetry emits the rework afk backlog', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runBacklogRetry(
        stubProvider([{ ...stubItem, state: 'blocked', executionMode: 'hitl' }]),
        '42',
        'operator retry',
        { json: true },
      );
    } finally {
      process.stdout.write = original;
    }
    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: true,
      kind: 'backlog.retry',
      data: { id: '42', state: 'rework', executionMode: 'afk' },
    });
  });

  it('runBacklogConfirmMerge emits the completed root backlog', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    const item = { ...stubItem, state: 'merge_ready' as const, executionMode: 'hitl' as const };
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: item.branchName, targetBranch: 'main' }),
      merge: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: item.branchName, targetBranch: 'main' }),
    };
    try {
      await runBacklogConfirmMerge(stubProvider([item]), changes, '42', 'main', { json: true });
    } finally {
      process.stdout.write = original;
    }
    expect(JSON.parse(captured.join(''))).toMatchObject({
      ok: true,
      kind: 'backlog.confirm-merge',
      data: { id: '42', state: 'done' },
    });
  });

  it('classifies lifecycle domain failures as validation JSON errors', async () => {
    const cases = [
      {
        kind: 'backlog.interrupt',
        run: () => runBacklogInterrupt(stubProvider([{ ...stubItem, state: 'ready' }]), '42', 'stop', { json: true }),
      },
      {
        kind: 'backlog.retry',
        run: () => runBacklogRetry(stubProvider([{ ...stubItem, state: 'blocked', executionMode: 'afk' }]), '42', 'retry', { json: true }),
      },
      {
        kind: 'backlog.confirm-merge',
        run: () => runBacklogConfirmMerge(
          stubProvider([{ ...stubItem, state: 'merge_ready', executionMode: 'hitl', parentId: '7' }]),
          { findForBacklog: vi.fn(), merge: vi.fn(), get: vi.fn() },
          '42',
          'main',
          { json: true },
        ),
      },
      {
        kind: 'backlog.confirm-merge',
        run: () => runBacklogConfirmMerge(
          stubProvider([{ ...stubItem, state: 'merge_ready', executionMode: 'hitl' }]),
          { findForBacklog: vi.fn().mockResolvedValue(null), merge: vi.fn(), get: vi.fn() },
          '42',
          'main',
          { json: true },
        ),
      },
      {
        kind: 'backlog.confirm-merge',
        run: () => runBacklogConfirmMerge(
          stubProvider([{ ...stubItem, state: 'merge_ready', executionMode: 'hitl' }]),
          { findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'closed', sourceBranch: stubItem.branchName, targetBranch: 'main' }), merge: vi.fn(), get: vi.fn() },
          '42',
          'main',
          { json: true },
        ),
      },
      {
        kind: 'backlog.confirm-merge',
        run: () => runBacklogConfirmMerge(
          stubProvider([{ ...stubItem, state: 'merge_ready', executionMode: 'hitl' }]),
          {
            findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: stubItem.branchName, targetBranch: 'main' }),
            merge: vi.fn(),
            get: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: stubItem.branchName, targetBranch: 'main' }),
          },
          '42',
          'main',
          { json: true },
        ),
      },
    ];
    const original = process.stdout.write.bind(process.stdout);
    const previousExitCode = process.exitCode;
    try {
      for (const testCase of cases) {
        const captured: string[] = [];
        process.stdout.write = (chunk: string | Uint8Array): boolean => {
          captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
          return true;
        };
        process.exitCode = undefined;
        await testCase.run();
        expect(JSON.parse(captured.join(''))).toMatchObject({
          ok: false,
          kind: testCase.kind,
          error: { code: 'validation' },
        });
      }
    } finally {
      process.stdout.write = original;
      process.exitCode = previousExitCode;
    }
  });
});

describe('backlog children', () => {
  function workItem(id: string, overrides: Partial<GlobalWorkItem> = {}): GlobalWorkItem {
    const [identity, issueNumber] = id.split('#');
    const projectKey = identity?.split(':')[1] ?? 'group/repo';
    return {
      id,
      issueNumber: Number(issueNumber),
      project: { platform: 'gitlab', projectKey, name: projectKey.split('/').at(-1) ?? projectKey },
      title: id,
      managed: true,
      executionEligible: false,
      state: 'ready',
      executionMode: 'hitl',
      dependsOn: [],
      tags: [],
      branchName: `feature/${issueNumber}`,
      providerRef: id,
      webUrl: `https://example.test/${id}`,
      ...overrides,
    };
  }

  // A PRD anchor is a container: it carries the role and has no state.
  const parent = workItem('gitlab:group/repo#7', { title: 'the PRD', kind: 'prd', state: undefined });
  const child = workItem('gitlab:group/repo#8', { parentId: parent.id, title: 'child issue' });
  const unmanaged = workItem('gitlab:group/repo#9', { parentId: parent.id, title: 'manual issue', managed: false });

  async function capture(run: () => Promise<void>): Promise<Record<string, unknown>> {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const previousExitCode = process.exitCode;
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await run();
    } finally {
      process.stdout.write = original;
      process.exitCode = previousExitCode;
    }
    return JSON.parse(captured.join('')) as Record<string, unknown>;
  }

  async function captureText(run: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(' '));
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('lists the issues that belong to one work item', async () => {
    const envelope = await capture(() => runBacklogChildren(parent.id, { json: true }, {
      read: async () => ({ items: [parent, child, unmanaged], lastSuccessAt: Date.now() }),
      collect: async () => undefined,
    }));

    expect(envelope).toMatchObject({
      ok: true,
      kind: 'backlog.children',
      data: {
        parent: { id: parent.id, title: 'the PRD' },
        children: [
          { id: child.id, title: 'child issue', managed: true },
          { id: unmanaged.id, title: 'manual issue', managed: false },
        ],
      },
    });
  });

  it('says why a child is not moving, not only where it stands', async () => {
    const waiting = workItem('gitlab:group/repo#10', {
      parentId: parent.id, title: 'waiting', executionMode: 'afk', executionEligible: true,
      dependsOn: ['gitlab:group/repo#11'],
    });
    const dependency = workItem('gitlab:group/repo#11', { state: 'blocked' });
    const envelope = await capture(() => runBacklogChildren(parent.id, { json: true }, {
      read: async () => ({ items: [parent, waiting, dependency], lastSuccessAt: Date.now() }),
      collect: async () => undefined,
    }));

    const children = (envelope.data as { children: { id: string; runnability?: unknown }[] }).children;
    // The state says where the item stands; the runnability says what holds
    // it back. A board of states alone cannot tell a queue from a deadlock.
    expect(children.find(candidate => candidate.id === waiting.id)?.runnability).toEqual({
      runnable: false,
      reason: 'dependency_not_done',
      blockedBy: ['gitlab:group/repo#11'],
    });
  });

  it('prints the provider URL of every item next to its title', async () => {    const output = await captureText(() => runBacklogChildren(parent.id, {}, {
      read: async () => ({ items: [parent, child], lastSuccessAt: Date.now() }),
      collect: async () => undefined,
    }));

    const lines = output.split('\n');
    const parentLine = lines.find(line => line.includes(parent.id)) ?? '';
    const childLine = lines.find(line => line.includes(child.id)) ?? '';
    // The URL belongs to the line that names the item, so a terminal can
    // link it and a person does not have to look for it.
    expect(parentLine).toContain(parent.webUrl);
    expect(childLine).toContain(child.webUrl);
  });

  it('reports an identity that is not a work item id', async () => {
    const envelope = await capture(() => runBacklogChildren('not-an-id', { json: true }, {
      read: async () => undefined,
      collect: async () => undefined,
    }));

    expect(envelope).toMatchObject({
      ok: false,
      kind: 'backlog.children',
      error: { code: 'validation' },
    });
  });

  it('lists the children of an item addressed by its issue number', async () => {
    const envelope = await capture(() => runBacklogChildren('7', { json: true }, {
      resolve: async (value: string) => {
        expect(value).toBe('7');
        return parent.id;
      },
      read: async () => ({ items: [parent, child, unmanaged], lastSuccessAt: Date.now() }),
      collect: async () => undefined,
    }));

    expect(envelope).toMatchObject({
      ok: true,
      kind: 'backlog.children',
      data: {
        parent: { id: parent.id, title: 'the PRD' },
        children: [{ id: child.id }, { id: unmanaged.id }],
      },
    });
  });

  it('reports an issue number whose project cannot be resolved', async () => {
    const envelope = await capture(() => runBacklogChildren('7', { json: true }, {
      resolve: async () => {
        throw new Error('A tracker project must be resolved before the provider can be created.');
      },
      read: async () => undefined,
      collect: async () => undefined,
    }));

    expect(envelope).toMatchObject({
      ok: false,
      kind: 'backlog.children',
      error: { code: 'validation' },
    });
  });

  it('reports a work item that does not exist', async () => {
    const envelope = await capture(() => runBacklogChildren('gitlab:group/repo#404', { json: true }, {
      read: async () => ({ items: [parent, child], lastSuccessAt: Date.now() }),
      collect: async () => undefined,
    }));

    expect(envelope).toMatchObject({
      ok: false,
      kind: 'backlog.children',
      error: { code: 'not_found' },
    });
  });
});

describe('backlog children identity', () => {
  const target = {
    platform: 'gitlab' as const,
    projectId: 'group/repo',
    host: 'gitlab.example.test',
    platformSource: 'index' as const,
    projectSource: 'index' as const,
  };

  it('keeps a canonical identity as it is', async () => {
    await expect(resolveBacklogChildrenIdentity('gitlab:group/repo#7', {}, { target: async () => target }))
      .resolves.toBe('gitlab:group/repo#7');
  });

  it('reads an issue number through the project that owns it', async () => {
    await expect(resolveBacklogChildrenIdentity('7', {}, { target: async (options) => {
      expect(options).toMatchObject({ issueId: '7' });
      return target;
    } })).resolves.toBe('gitlab:gitlab.example.test/group/repo#7');
  });

  it('passes an explicit project and platform on', async () => {
    await expect(resolveBacklogChildrenIdentity('7', { project: 'group/other', platform: 'gitlab' }, { target: async (options) => {
      expect(options).toMatchObject({ project: 'group/other', platform: 'gitlab', issueId: '7' });
      return { ...target, projectId: 'group/other' };
    } })).resolves.toBe('gitlab:gitlab.example.test/group/other#7');
  });

  it('reads the instance from the index when the target does not name one', async () => {
    await expect(resolveBacklogChildrenIdentity('7', {}, {
      target: async () => ({ ...target, host: undefined }),
      host: () => 'gitlab.example.test',
    })).resolves.toBe('gitlab:gitlab.example.test/group/repo#7');
  });

  it('keeps the host a project already carries', async () => {
    await expect(resolveBacklogChildrenIdentity('7', { project: 'gitlab.example.test/group/other' }, {
      target: async () => ({ ...target, projectId: 'gitlab.example.test/group/other', host: undefined }),
      host: () => undefined,
    })).resolves.toBe('gitlab:gitlab.example.test/group/other#7');
  });

  it('refuses an id that is neither an issue number nor a canonical identity', async () => {
    await expect(resolveBacklogChildrenIdentity('not-an-id', {}, { target: async () => target }))
      .rejects.toThrow(/must be an issue number or platform:projectKey#issueNumber/);
  });
});
