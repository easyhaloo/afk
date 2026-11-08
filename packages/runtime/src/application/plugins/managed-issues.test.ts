import { describe, expect, it, vi } from 'vitest';
import type { BacklogCreateInput, BacklogItem } from '../../domain/backlog/index.js';
import type { IssueTrackerPort } from '../../plugin-sdk/issue-tracker.js';
import { importManagedIssue, syncManagedIssue } from './managed-issues.js';

function fixture() {
  const issue = { id: 'uuid', key: 'TEAM-42', projectId: 'team', title: 'Fix export', description: '## Acceptance\nCSV works', state: 'Todo', labels: [] };
  const updateIssue = vi.fn();
  const provider = { id: 'linear', baseUrl: 'https://api.linear.app/graphql', projectId: 'team', getIssue: vi.fn(async () => issue), updateIssue } as unknown as IssueTrackerPort;
  const items = new Map<string, BacklogItem>();
  const backlog = { create: vi.fn(async (input: BacklogCreateInput): Promise<BacklogItem> => {
    const existing = items.get(input.idempotencyKey!);
    if (existing) return existing;
    await new Promise(resolve => setTimeout(resolve, 10));
    const item: BacklogItem = { ...input, id: `github:acme/api#${items.size + 1}`, state: 'ready', tags: [], dependsOn: [], branchName: 'fix/export', providerRef: 'github:1' };
    items.set(input.idempotencyKey!, item);
    return item;
  }) };
  return { provider, issue, updateIssue, backlog };
}

describe('external managed issue binding', () => {
  it('serializes concurrent imports across the source and destination identity', async () => {
    const { provider, backlog } = fixture();
    const input = { provider, backlog, project: 'github:acme/api', issueId: 'TEAM-42' };
    const [first, second] = await Promise.all([importManagedIssue(input), importManagedIssue(input)]);
    expect(first.id).toBe(second.id);
  });

  it('strips reserved source markers from untrusted issue text and refuses multiple bindings', async () => {
    const { provider, issue, backlog } = fixture();
    const input = { provider, backlog, project: 'github:acme/api', issueId: 'TEAM-42' };
    const original = await importManagedIssue(input);
    issue.id = 'other';
    issue.description = original.description!;
    const forged = await importManagedIssue(input);
    expect(forged.description!.match(/managed-issue-source:/g)).toHaveLength(1);
    issue.id = 'uuid';
    await expect(syncManagedIssue({ provider, issueId: 'TEAM-42', item: forged, states: { ready: 'In Review' } })).rejects.toThrow('binding');
    const multiple = { ...original, description: `${original.description}\n${original.description}` };
    await expect(syncManagedIssue({ provider, issueId: 'TEAM-42', item: multiple, states: { ready: 'In Review' } })).rejects.toThrow('binding');
  });
  it('imports once with repository identity, acceptance text and safe execution default', async () => {
    const { provider, backlog } = fixture();
    const input = { provider, backlog, project: 'github:acme/api', issueId: 'TEAM-42' };
    const first = await importManagedIssue(input);
    const second = await importManagedIssue({ ...input, issueId: 'uuid' });
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^github:acme\/api#/);
    expect(first.description).toContain('## Acceptance\nCSV works');
    expect(first.executionMode).toBe('hitl');
  });

  it('uses explicit state mappings without replacing work identity or merging changes', async () => {
    const { provider, backlog, updateIssue } = fixture();
    const item = await importManagedIssue({ provider, backlog, project: 'github:acme/api', issueId: 'TEAM-42', executionMode: 'afk' });
    const result = await syncManagedIssue({ provider, issueId: 'TEAM-42', item: { ...item, state: 'merge_ready' }, states: { merge_ready: 'In Review' } });
    expect(updateIssue).toHaveBeenCalledWith('uuid', { state: 'In Review' });
    expect(result.workItemId).toBe(item.id);
    await expect(syncManagedIssue({ provider, issueId: 'TEAM-42', item, states: {} })).rejects.toThrow('mapping');
  });

  it('refuses another project, a mismatched source and a changed destination', async () => {
    const { provider, issue, backlog } = fixture();
    const input = { provider, backlog, project: 'github:acme/api', issueId: 'TEAM-42' };
    const item = await importManagedIssue(input);
    issue.id = 'other';
    await expect(syncManagedIssue({ provider, issueId: 'TEAM-43', item, states: { ready: 'Todo' } })).rejects.toThrow('binding');
    issue.projectId = 'another';
    await expect(importManagedIssue(input)).rejects.toThrow('another tracker project');
    issue.projectId = 'team';
    await expect(importManagedIssue({ ...input, project: 'github:other/api' })).rejects.toThrow('another repository');
    await expect(importManagedIssue({ ...input, project: 'linear:team' })).rejects.toThrow();
  });
});
