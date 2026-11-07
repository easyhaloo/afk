import { describe, expect, it, vi } from 'vitest';
import { LinearTrackerProvider } from './linear-provider.js';

const end: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null };
const page = (nodes: unknown[], pageInfo = end) => ({ nodes, pageInfo });
const issue = (id = 'uuid-1', teamId = 'team-1') => ({
  id, identifier: 'ENG-42', title: 'Fix it', description: 'Details', url: 'https://linear.test/ENG-42',
  team: { id: teamId }, state: { name: 'Todo' }, labels: page([{ name: 'bug' }]),
});
const comment = (id = 'comment-1') => ({ id, body: 'hello', user: { name: 'Bot' }, createdAt: '2026-11-06', updatedAt: '2026-11-06' });
const relation = (id: string, type = 'blocks', source = 'uuid-1', target = 'uuid-2') => ({ id, type, issue: { id: source }, relatedIssue: { id: target } });

function setup(...payloads: unknown[]) {
  const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockImplementation(async () => {
    if (!payloads.length) throw new Error('unexpected request');
    return new Response(JSON.stringify(payloads.shift()), { status: 200 });
  });
  const provider = new LinearTrackerProvider({ baseUrl: 'https://linear.test/graphql', token: 'secret-token', teamId: 'team-1', fetch: fetcher });
  const request = (index: number) => JSON.parse(String(fetcher.mock.calls[index][1]?.body)) as { query: string; variables: Record<string, any> };
  return { provider, fetcher, request };
}

describe('LinearTrackerProvider', () => {
  it('preserves the native UUID and team and sends credentials only in headers', async () => {
    const { provider, fetcher, request } = setup({ data: { issue: issue() } });
    await expect(provider.getIssue('uuid-1')).resolves.toMatchObject({ id: 'uuid-1', key: 'ENG-42', projectId: 'team-1' });
    expect(request(0).variables).toEqual({ id: 'uuid-1' });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('secret-token');
    expect(String(fetcher.mock.calls[0][0])).toBe('https://linear.test/graphql');
  });

  it('filters every requested label and state on the server and fills the limit across short pages', async () => {
    const { provider, request } = setup(
      { data: { issues: page([issue('uuid-1')], { hasNextPage: true, endCursor: 'page-2' }) } },
      { data: { issues: page([issue('uuid-2')], { hasNextPage: true, endCursor: 'page-3' }) } },
    );
    await expect(provider.listIssues({ labels: ['bug', 'urgent'], state: 'Todo', limit: 2, cursor: 'initial' })).resolves.toHaveLength(2);
    expect(request(0).variables).toEqual({
      first: 2, after: 'initial', filter: {
        team: { id: { eq: 'team-1' } }, state: { name: { eqIgnoreCase: 'Todo' } },
        and: [{ labels: { some: { name: { eq: 'bug' } } } }, { labels: { some: { name: { eq: 'urgent' } } } }],
      },
    });
    expect(request(1).variables).toMatchObject({ first: 1, after: 'page-2' });
  });

  it('does not cap the caller limit to one API page', async () => {
    const { provider, request } = setup(
      { data: { issues: page(Array.from({ length: 100 }, (_, index) => issue(`uuid-${index}`)), { hasNextPage: true, endCursor: 'next' }) } },
      { data: { issues: page([issue('last')]) } },
    );
    await expect(provider.listIssues({ limit: 101 })).resolves.toHaveLength(101);
    expect(request(0).variables.first).toBe(100);
    expect(request(1).variables.first).toBe(1);
  });

  it('loads all labels attached to an issue', async () => {
    const { provider, request } = setup(
      { data: { issue: { ...issue(), labels: page([{ name: 'bug' }], { hasNextPage: true, endCursor: 'labels-next' }) } } },
      { data: { issue: { labels: page([{ name: 'urgent' }]) } } },
    );
    await expect(provider.getIssue('uuid-1')).resolves.toMatchObject({ labels: ['bug', 'urgent'] });
    expect(request(1).variables).toEqual({ id: 'uuid-1', after: 'labels-next' });
  });

  it('resolves workspace and team labels with pagination and prefers the team label', async () => {
    const { provider, request } = setup(
      { data: { issueLabels: page([{ id: 'global', name: 'bug', team: null }], { hasNextPage: true, endCursor: 'labels-next' }) } },
      { data: { issueLabels: page([{ id: 'local', name: 'bug', team: { id: 'team-1' } }]) } },
      { data: { issueCreate: { success: true, issue: issue() } } },
    );
    await provider.createIssue({ title: 'Fix it', labels: ['bug'] });
    expect(request(0).variables.filter.or).toEqual([{ team: { id: { eq: 'team-1' } } }, { team: { null: true } }]);
    expect(request(1).variables.after).toBe('labels-next');
    expect(request(2).variables.input.labelIds).toEqual(['local']);
  });

  it('resolves state for the actual issue team and clears labels explicitly', async () => {
    const updated = { ...issue('uuid-1', 'other-team'), state: { name: 'Done' }, labels: page([]) };
    const { provider, request } = setup(
      { data: { issue: issue('uuid-1', 'other-team') } },
      { data: { workflowStates: { nodes: [{ id: 'state-done' }] } } },
      { data: { issueUpdate: { success: true, issue: updated } } },
    );
    await expect(provider.updateIssue('uuid-1', { state: 'Done', labels: [] })).resolves.toMatchObject({ state: 'Done', labels: [] });
    expect(request(1).variables.filter).toEqual({ team: { id: { eq: 'other-team' } }, name: { eqIgnoreCase: 'Done' } });
    expect(request(2).variables.input).toEqual({ stateId: 'state-done', labelIds: [] });
  });

  it('creates, pages, updates and deletes comments using the real GraphQL mutations', async () => {
    const owner = { data: { comment: { issue: { id: 'uuid-1', identifier: 'ENG-42' } } } };
    const { provider, request } = setup(
      { data: { commentCreate: { success: true, comment: comment() } } },
      { data: { issue: { comments: page([comment()], { hasNextPage: true, endCursor: 'more-comments' }) } } },
      { data: { issue: { comments: page([comment('comment-2')]) } } },
      owner,
      { data: { commentUpdate: { success: true, comment: { ...comment(), body: 'updated' } } } },
      owner,
      { data: { commentDelete: { success: true } } },
    );
    await expect(provider.addComment('uuid-1', 'hello')).resolves.toMatchObject({ id: 'comment-1', issueId: 'uuid-1', body: 'hello' });
    await expect(provider.listComments('uuid-1')).resolves.toHaveLength(2);
    await expect(provider.updateComment('ENG-42', 'comment-1', 'updated')).resolves.toMatchObject({ body: 'updated' });
    await provider.deleteComment('uuid-1', 'comment-1');
    expect(request(2).variables.after).toBe('more-comments');
    expect(request(4).query).toContain('commentUpdate');
    expect(request(6).query).toContain('commentDelete');
  });

  it('does not mutate a comment belonging to a different issue', async () => {
    const { provider, fetcher } = setup({ data: { comment: { issue: { id: 'uuid-2', identifier: 'ENG-43' } } } });
    await expect(provider.deleteComment('uuid-1', 'comment-1')).rejects.toMatchObject({ code: 'not-found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reverses blocked-by on creation and reads both outgoing and incoming relationships', async () => {
    const { provider, request } = setup(
      { data: { issueRelationCreate: { success: true, issueRelation: relation('created', 'blocks', 'uuid-2', 'uuid-1') } } },
      { data: { issue: { relations: page([relation('out')], { hasNextPage: true, endCursor: 'next-relation' }) } } },
      { data: { issue: { relations: page([relation('related', 'related')]) } } },
      { data: { issue: { inverseRelations: page([relation('in', 'blocks', 'uuid-3', 'uuid-1')]) } } },
    );
    await expect(provider.linkIssues('uuid-1', 'uuid-2', 'blocked-by')).resolves.toEqual({ id: 'created', sourceIssueId: 'uuid-1', targetIssueId: 'uuid-2', type: 'blocked-by' });
    expect(request(0).variables.input).toEqual({ issueId: 'uuid-2', relatedIssueId: 'uuid-1', type: 'blocks' });
    await expect(provider.listIssueLinks('uuid-1')).resolves.toEqual([
      { id: 'out', sourceIssueId: 'uuid-1', targetIssueId: 'uuid-2', type: 'blocks' },
      { id: 'related', sourceIssueId: 'uuid-1', targetIssueId: 'uuid-2', type: 'relates-to' },
      { id: 'in', sourceIssueId: 'uuid-1', targetIssueId: 'uuid-3', type: 'blocked-by' },
    ]);
  });

  it.each(['relates-to', 'duplicates'] as const)('maps %s to the native enum', async type => {
    const nativeType = type === 'relates-to' ? 'related' : 'duplicate';
    const { provider, request } = setup({ data: { issueRelationCreate: { success: true, issueRelation: relation('link', nativeType) } } });
    await provider.linkIssues('uuid-1', 'uuid-2', type);
    expect(request(0).variables.input.type).toBe(nativeType);
  });

  it('rejects unknown relation semantics instead of relabeling them', async () => {
    const { provider } = setup(
      { data: { issue: { relations: page([relation('similar', 'similar')]) } } },
    );
    await expect(provider.listIssueLinks('uuid-1')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it.each([null, 'same'])('rejects a missing or non-advancing pagination cursor (%s)', async cursor => {
    const { provider } = setup({ data: { issues: page([], { hasNextPage: true, endCursor: cursor }) } });
    await expect(provider.listIssues({ cursor: 'same' })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([0, -1, NaN, 1.5, Infinity])('rejects invalid limits (%s)', async limit => {
    const { provider, fetcher } = setup();
    await expect(provider.listIssues({ limit })).rejects.toMatchObject({ code: 'configuration' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { data: { issueDelete: { success: false } } },
    { data: {} },
    { data: { issueDelete: { success: true } }, errors: [{ message: 'secret-token' }] },
  ])('does not accept GraphQL errors or failed mutation payloads', async payload => {
    const { provider } = setup(payload);
    await expect(provider.deleteIssue('uuid-1')).rejects.toBeInstanceOf(Error);
  });

  it('validates health data and never reports an arbitrary HTTP 200 as healthy', async () => {
    const { provider } = setup({ data: {} }, { data: { viewer: { id: 'viewer-1' } } });
    await expect(provider.health()).resolves.toMatchObject({ status: 'unavailable' });
    await expect(provider.doctor()).resolves.toEqual([{ check: 'credentials', ok: true, detail: undefined }]);
  });
});
