import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerBacklogCommands, runBacklogApplyManifest } from './backlog.js';
import type { BacklogCreateInput, BacklogItem, BacklogManagementProvider } from '@afk/runtime/domain/backlog/index';

function commandTree(register: (program: Command) => void): Command {
  const program = new Command();
  program.name('afk').exitOverride();
  register(program);
  return program;
}

interface Recorded {
  project: string;
  input: BacklogCreateInput;
}

function provider(recorded: Recorded[], project: string): BacklogManagementProvider {
  return {
    async get() { throw new Error('not used'); },
    async list() { return []; },
    async planCreate() { throw new Error('not used'); },
    async create(input: BacklogCreateInput): Promise<BacklogItem> {
      recorded.push({ project, input });
      const id = `${project}#${recorded.length}`;
      return {
        id, issueNumber: recorded.length, title: input.title, description: input.description,
        dependsOn: [...(input.dependsOn ?? [])], state: 'ready', executionMode: input.executionMode ?? 'afk',
        tags: [...(input.tags ?? [])], branchName: `feature/${recorded.length}`, providerRef: id,
        webUrl: `https://example.test/${id}`,
      };
    },
    async addTag() { /* noop */ },
    async removeTag() { /* noop */ },
    async initialize() { /* noop */ },
  } as unknown as BacklogManagementProvider;
}

const manifest = `
- title: Publish the route map
  description: Publish the enterprise route mapping.
  project: github:org/api
  ref: route
- title: Resolve the endpoint
  description: Resolve the private endpoint.
  project: github:org/web
  ref: endpoint
  dependsOn: [route]
`;

async function capture(run: () => Promise<void>): Promise<string> {
  const captured: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return captured.join('');
}

describe('backlog apply-manifest', () => {
  it('exposes the command with its options', () => {
    const program = commandTree(registerBacklogCommands);
    const backlog = program.commands.find(command => command.name() === 'backlog')!;
    const apply = backlog.commands.find(command => command.name() === 'apply-manifest')!;

    expect(apply.registeredArguments.map(argument => argument.name())).toEqual(['manifest']);
    expect(apply.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--project', '--platform', '--idempotency-key', '--dry-run', '--json',
    ]));
  });

  it('creates one record per item and reports them', async () => {
    const recorded: Recorded[] = [];
    const output = await capture(() => runBacklogApplyManifest({
      read: async () => manifest,
      create: async (project) => provider(recorded, project),
    }, { manifest: '/tmp/manifest.yml', json: true }));

    const envelope = JSON.parse(output);
    expect(envelope).toMatchObject({ ok: true, kind: 'backlog.apply-manifest' });
    expect(envelope.data.records.map((record: { project: string }) => record.project)).toEqual([
      'github:org/api', 'github:org/web',
    ]);
    expect(recorded.map(entry => entry.input.title)).toEqual(['Publish the route map', 'Resolve the endpoint']);
    expect(recorded[1]?.input.dependsOn).toEqual(['github:org/api#1']);
  });

  it('writes nothing on a dry run', async () => {
    const recorded: Recorded[] = [];
    const output = await capture(() => runBacklogApplyManifest({
      read: async () => manifest,
      create: async (project) => provider(recorded, project),
    }, { manifest: '/tmp/manifest.yml', dryRun: true, json: true }));

    expect(recorded).toHaveLength(0);
    const envelope = JSON.parse(output);
    expect(envelope.data.records.map((record: { item: { title: string } }) => record.item.title)).toEqual([
      'Publish the route map', 'Resolve the endpoint',
    ]);
  });

  it('uses the default project for an item without one', async () => {
    const recorded: Recorded[] = [];
    await capture(() => runBacklogApplyManifest({
      read: async () => '- title: One\n  description: Body.',
      create: async (project) => provider(recorded, project),
    }, { manifest: '/tmp/manifest.yml', project: 'github:org/api', json: true }));

    expect(recorded[0]?.project).toBe('github:org/api');
  });

  it('reports a manifest that cannot be applied', async () => {
    const output = await capture(() => runBacklogApplyManifest({
      read: async () => '- title: One\n  description: Body.\n  project: github:org/api\n  dependsOn: [missing]',
      create: async () => { throw new Error('not used'); },
    }, { manifest: '/tmp/manifest.yml', json: true }));

    const envelope = JSON.parse(output);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain('missing');
  });
});
