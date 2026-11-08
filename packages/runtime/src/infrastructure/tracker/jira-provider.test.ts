import { describe, expect, it, vi } from 'vitest';
import { JiraTrackerProvider, type JiraTrackerOptions } from './jira-provider.js';

const adf = (...paragraphs: string[][]) => ({
  type: 'doc', version: 1, content: paragraphs.map(texts => ({ type: 'paragraph', content: texts.map(text => ({ type: 'text', text })) })),
});
const issue = (key = 'ENG-42') => ({ id: '10001', key, fields: { summary: 'Title', description: adf(['Details']), labels: ['bug'], status: { name: 'To Do' } } });
const comment = (id = 'comment-1') => ({ id, body: adf(['Hello ', 'world']), author: { displayName: 'Bot' } });
const link = (id = 'real-link-id', inward = false, name = 'Blocks') => ({ id, type: { name }, [inward ? 'inwardIssue' : 'outwardIssue']: { key: 'ENG-43', id: '10002' } });
const links = (nodes = [link()]) => ({ key: 'ENG-42', fields: { issuelinks: nodes } });

function setup(responses: { status?: number; body?: unknown }[], options: Partial<JiraTrackerOptions> = {}) {
  const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockImplementation(async () => {
    if (!responses.length) throw new Error('unexpected request');
    const response = responses.shift()!;
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), { status: response.status ?? 200 });
  });
  const provider = new JiraTrackerProvider({ baseUrl: 'https://jira.test', projectKey: 'ENG', token: 'secret-token', fetch: fetcher, ...options });
  const request = (index: number) => JSON.parse(String(fetcher.mock.calls[index][1]?.body));
  return { provider, fetcher, request };
}

describe('JiraTrackerProvider', () => {
  it('creates native Jira keys with ADF paragraphs and preserves the configured base path', async () => {
    const { provider, fetcher, request } = setup([{ status: 201, body: { id: '10001', key: 'ENG-42' } }, { body: issue() }], { baseUrl: 'https://jira.test/ex/jira/cloud-id', email: 'bot@example.test' });
    await expect(provider.createIssue({ title: 'Title', description: 'one\n\nthree', labels: ['bug'] })).resolves.toMatchObject({ id: 'ENG-42', key: 'ENG-42', description: 'Details' });
    expect(request(0).fields).toEqual({ project: { key: 'ENG' }, summary: 'Title', description: adf(['one'], [], ['three']), labels: ['bug'], issuetype: { name: 'Task' } });
    expect(String(fetcher.mock.calls[0][0])).toBe('https://jira.test/ex/jira/cloud-id/rest/api/3/issue');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe(`Basic ${Buffer.from('bot@example.test:secret-token').toString('base64')}`);
  });

  it('uses current Cloud search/jql with fields, AND labels, escaped JQL and opaque cursors', async () => {
    const { provider, request, fetcher } = setup([
      { body: { issues: [issue()], isLast: false, nextPageToken: 'next-page' } },
      { body: { issues: [issue('ENG-43')], isLast: true } },
    ], { projectKey: 'ENG"\\ AND project = ALL' });
    await expect(provider.listIssues({ limit: 2, cursor: 'first-token', state: 'In Progress', labels: ['bug"\\', 'urgent'] })).resolves.toHaveLength(2);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://jira.test/rest/api/3/search/jql');
    expect(request(0)).toEqual({
      jql: 'project = "ENG\\"\\\\ AND project = ALL" AND status = "In Progress" AND labels = "bug\\"\\\\" AND labels = "urgent" ORDER BY updated DESC, key ASC',
      fields: ['summary', 'description', 'labels', 'status'], maxResults: 2, nextPageToken: 'first-token',
    });
    expect(request(1)).toMatchObject({ maxResults: 1, nextPageToken: 'next-page' });
  });

  it('supports total limits beyond a single search page', async () => {
    const { provider, request } = setup([
      { body: { issues: Array.from({ length: 100 }, (_, index) => issue(`ENG-${index}`)), isLast: false, nextPageToken: 'next' } },
      { body: { issues: [issue('ENG-101')], isLast: true } },
    ]);
    await expect(provider.listIssues({ limit: 101 })).resolves.toHaveLength(101);
    expect(request(0).maxResults).toBe(100);
    expect(request(1).maxResults).toBe(1);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid limit %s before issuing a request', async limit => {
    const { provider, fetcher } = setup([]);
    await expect(provider.listIssues({ limit })).rejects.toMatchObject({ code: 'configuration' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, 'initial'])('rejects missing or repeated continuation tokens (%s)', async nextPageToken => {
    const { provider } = setup([{ body: { issues: [], isLast: false, nextPageToken } }]);
    await expect(provider.listIssues({ cursor: 'initial' })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('rejects control characters instead of interpolating them into JQL', async () => {
    const { provider, fetcher } = setup([]);
    await expect(provider.listIssues({ labels: ['bad\nlabel'] })).rejects.toMatchObject({ code: 'configuration' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('concatenates inline text, preserves paragraph boundaries, blanks and hardBreaks', async () => {
    const description = adf(['Hello ', 'world'], [], ['Last']);
    description.content[2].content.push({ type: 'hardBreak', text: '' }, { type: 'text', text: 'line' });
    const { provider } = setup([{ body: { ...issue(), fields: { ...issue().fields, description } } }]);
    await expect(provider.getIssue('ENG-42')).resolves.toMatchObject({ description: 'Hello world\n\nLast\nline' });
  });

  it('updates fields and uses the transition destination state rather than its action name', async () => {
    const { provider, request } = setup([
      { body: { transitions: [{ id: '31', name: 'Resolve', to: { name: 'Done' } }] } },
      { status: 204 }, { status: 204 }, { body: issue() },
    ]);
    await provider.updateIssue('ENG-42', { title: 'New', description: '', labels: [], state: 'Done' });
    expect(request(1)).toEqual({ fields: { summary: 'New', description: adf([]), labels: [] } });
    expect(request(2)).toEqual({ transition: { id: '31' } });
  });

  it('does not apply field updates when the requested transition is unavailable', async () => {
    const { provider, fetcher } = setup([{ body: { transitions: [{ id: '31', name: 'Done', to: { name: 'Review' } }] } }]);
    await expect(provider.updateIssue('ENG-42', { title: 'New', state: 'Done' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('pages comments and performs real create/update/delete comment and issue operations', async () => {
    const { provider, fetcher, request } = setup([
      { status: 201, body: comment() },
      { body: { comments: [comment()], startAt: 0, total: 2 } },
      { body: { comments: [comment('comment-2')], startAt: 1, total: 2 } },
      { body: { ...comment(), body: adf(['updated']) } },
      { status: 204 }, { status: 204 },
    ]);
    await expect(provider.addComment('ENG-42', 'Hello world')).resolves.toMatchObject({ id: 'comment-1', body: 'Hello world' });
    await expect(provider.listComments('ENG-42')).resolves.toHaveLength(2);
    await expect(provider.updateComment('ENG-42', 'comment-1', 'updated')).resolves.toMatchObject({ body: 'updated' });
    await provider.deleteComment('ENG-42', 'comment-1');
    await provider.deleteIssue('ENG-42');
    expect(request(0)).toEqual({ body: adf(['Hello world']) });
    expect(String(fetcher.mock.calls[2][0])).toContain('startAt=1');
    expect(fetcher.mock.calls[4][1]?.method).toBe('DELETE');
    expect(fetcher.mock.calls[5][1]?.method).toBe('DELETE');
  });

  it('rejects non-advancing comment pages', async () => {
    const { provider } = setup([{ body: { comments: [], startAt: 0, total: 1 } }]);
    await expect(provider.listComments('ENG-42')).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each(['blocks', 'blocked-by', 'relates-to', 'duplicates'] as const)('writes %s with the correct direction and returns its real server ID', async type => {
    const reversed = type === 'blocked-by';
    const name = type === 'relates-to' ? 'Relates' : type === 'duplicates' ? 'Duplicate' : 'Blocks';
    const { provider, request } = setup([{ status: 201 }, { body: links([link('native-123', reversed, name)]) }]);
    await expect(provider.linkIssues('ENG-42', 'ENG-43', type)).resolves.toEqual({ id: 'native-123', sourceIssueId: 'ENG-42', targetIssueId: 'ENG-43', type });
    expect(request(0)).toEqual({ type: { name }, inwardIssue: { key: reversed ? 'ENG-43' : 'ENG-42' }, outwardIssue: { key: reversed ? 'ENG-42' : 'ENG-43' } });
  });

  it('normalizes incoming and outgoing links without confusing blocked-by or duplicates direction', async () => {
    const { provider } = setup([{ body: links([link('out'), link('in', true), link('dup', true, 'Duplicate'), link('related', false, 'Relates')]) }]);
    await expect(provider.listIssueLinks('ENG-42')).resolves.toEqual([
      { id: 'out', sourceIssueId: 'ENG-42', targetIssueId: 'ENG-43', type: 'blocks' },
      { id: 'in', sourceIssueId: 'ENG-42', targetIssueId: 'ENG-43', type: 'blocked-by' },
      { id: 'dup', sourceIssueId: 'ENG-43', targetIssueId: 'ENG-42', type: 'duplicates' },
      { id: 'related', sourceIssueId: 'ENG-42', targetIssueId: 'ENG-43', type: 'relates-to' },
    ]);
  });

  it('allows configured native link type names and rejects unrepresentable relationships', async () => {
    const configured = setup([{ body: links([link('custom', false, 'Precedes')]) }], { linkTypes: { blocks: 'Precedes' } });
    await expect(configured.provider.listIssueLinks('ENG-42')).resolves.toMatchObject([{ type: 'blocks' }]);
    const unknown = setup([{ body: links([link('custom', false, 'Cloners')]) }]);
    await expect(unknown.provider.listIssueLinks('ENG-42')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('does not fabricate a relation ID if read-back cannot confirm the created link', async () => {
    const { provider } = setup([{ status: 201 }, { body: links([]) }]);
    await expect(provider.linkIssues('ENG-42', 'ENG-43', 'blocks')).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([
    { status: 401, body: { error: 'secret-token' } },
    { body: { errorMessages: ['secret-token'], errors: {} } },
    { body: {} },
  ])('rejects errors and malformed success payloads without leaking secrets', async response => {
    const { provider } = setup([response]);
    const error = await provider.getIssue('ENG-42').catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret-token');
    expect(error.cause).toBeUndefined();
  });

  it('does not treat a wrong status or an arbitrary 200 health body as success', async () => {
    const { provider } = setup([{ status: 200, body: {} }, { body: {} }]);
    await expect(provider.deleteIssue('ENG-42')).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(provider.health()).resolves.toMatchObject({ status: 'unavailable' });
  });
});
