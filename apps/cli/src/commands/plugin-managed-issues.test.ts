import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginRuntime, type IssueTrackerPort } from '@afk/runtime/plugin-sdk';
import type { BacklogCreateInput } from '@afk/runtime/domain/backlog';
import { registerPluginCommands } from './plugin.js';

describe('managed external issue commands', () => {
  it('imports into a real repository bundle, then synchronizes only a bound explicit state', async () => {
    const runtime = new PluginRuntime();
    const issue = { id: 'uuid', key: 'TEAM-42', projectId: 'team', title: 'Fix export', description: 'Acceptance: CSV works', state: 'Todo', labels: [] };
    const updateIssue = vi.fn();
    const provider = { id: 'linear', baseUrl: 'https://api.linear.app/graphql', projectId: 'team', getIssue: async () => issue, updateIssue } as unknown as IssueTrackerPort;
    await runtime.activate({ manifest: { id: 'tracker.linear', version: '1.0.0', apiVersion: 1, provides: ['tracker.issue'], trusted: true }, activate(context) { context.registerIssueTrackerProvider('linear', provider); } });
    let item: Record<string, unknown>;
    const create = vi.fn(async (input: BacklogCreateInput) => item = { ...input, id: 'github:acme/api#42', state: 'merge_ready', tags: [], dependsOn: [], branchName: 'fix/export', providerRef: 'github:acme/api#42' });
    const get = vi.fn(async () => item);
    const assemble = vi.fn(async () => ({ providers: { backlog: { create, get } } }));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const directory = await mkdtemp(join(tmpdir(), 'managed-issue-cli-'));
    const program = () => {
      const command = new Command().exitOverride();
      registerPluginCommands(command, { pluginRuntime: runtime, assembleProviders: assemble as never });
      return command;
    };
    try {
      await program().parseAsync(['node', 'afk', 'plugin', 'import-issue', 'linear', 'TEAM-42', '--project', 'github:acme/api', '--mode', 'afk']);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'afk', idempotencyKey: expect.stringContaining('external-issue:') }));
      expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ platform: 'github', projectKey: 'acme/api', plugins: runtime }));
      const mapping = join(directory, 'states.json');
      await writeFile(mapping, JSON.stringify({ merge_ready: 'In Review', done: 'Done' }));
      await program().parseAsync(['node', 'afk', 'plugin', 'sync-issue', 'linear', 'TEAM-42', 'github:acme/api#42', '--states', mapping]);
      expect(get).toHaveBeenCalledWith('github:acme/api#42');
      expect(updateIssue).toHaveBeenCalledWith('uuid', { state: 'In Review' });
      await expect(program().parseAsync(['node', 'afk', 'plugin', 'import-issue', 'linear', 'TEAM-42', '--project', 'linear:team'])).rejects.toThrow();
      await expect(program().parseAsync(['node', 'afk', 'plugin', 'import-issue', 'missing', 'TEAM-42', '--project', 'github:acme/api'])).rejects.toThrow('not available');
      await writeFile(mapping, JSON.stringify({ unrecognized: 'Done' }));
      await expect(program().parseAsync(['node', 'afk', 'plugin', 'sync-issue', 'linear', 'TEAM-42', 'github:acme/api#42', '--states', mapping])).rejects.toThrow();
    } finally { output.mockRestore(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
