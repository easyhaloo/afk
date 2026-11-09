import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { assembleProviders } from '../../infrastructure/provider/assembly.js';
import type { BacklogCreateInput } from '../../domain/backlog/index.js';
import type { IssueTrackerPort } from '../../plugin-sdk/issue-tracker.js';
import { createDefaultPluginRuntime } from './default-runtime.js';

vi.mock('../../infrastructure/provider/assembly.js', () => ({ assembleProviders: vi.fn() }));

it('routes workflow import and sync actions through native managed providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-actions-'));
  const runtime = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: root });
  const source = { id: 'uuid', key: 'JIRA-42', projectId: 'JIRA', title: 'CSV', description: 'Acceptance: export', state: 'Todo', labels: [] };
  const updateIssue = vi.fn();
  await runtime.activate({ manifest: { id: 'tracker.fixture', version: '1.0.0', apiVersion: 1, provides: ['tracker.issue'], trusted: true }, activate(context) {
    context.registerIssueTrackerProvider('jira', { id: 'jira', baseUrl: 'https://jira.example.test', projectId: 'JIRA', getIssue: async () => source, updateIssue } as unknown as IssueTrackerPort);
  } });
  let managed: BacklogCreateInput & { id: string; state: 'verification'; tags: string[]; dependsOn: string[] };
  const create = vi.fn(async (input: BacklogCreateInput) => managed = { ...input, id: 'gitlab:group/api#42', state: 'verification' as const, tags: [], dependsOn: [] });
  const get = vi.fn(async () => managed);
  vi.mocked(assembleProviders).mockResolvedValue({ providers: { backlog: { create, get } } } as never);
  try {
    const result = await runtime.dispatchSystemAction('work-item.import', { input: { provider: 'jira', issueId: 'JIRA-42', project: 'gitlab:group/api', executionMode: 'afk' } });
    expect(result).toMatchObject({ id: 'gitlab:group/api#42', executionMode: 'afk' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.stringContaining('external-issue:') }));
    await expect(runtime.dispatchSystemAction('work-item.sync', { provider: 'jira', issueId: 'JIRA-42', workItemId: 'gitlab:group/api#42', states: { verification: 'In Test' } })).resolves.toMatchObject({ state: 'In Test', updated: true });
    expect(updateIssue).toHaveBeenCalledWith('uuid', { state: 'In Test' });
    await expect(runtime.dispatchSystemAction('work-item.import', { provider: 'missing', issueId: '42', project: 'gitlab:group/api' })).rejects.toThrow('not available');
    await expect(runtime.dispatchSystemAction('work-item.sync', { provider: 'missing', issueId: '42', workItemId: 'gitlab:group/api#42', states: {} })).rejects.toThrow('not available');
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
