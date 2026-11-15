import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { GeelibClient, geelibCanonical, geelibSign } from './client.js';
import type { TrackedIssue } from '../../domain/tracker/types.js';

const fetchMock = vi.fn();
const client = () => new GeelibClient({
  baseUrl: 'https://geelib.example',
  userMail: 'afk@example.com',
  token: 'afk-test-token',
  subId: 6856,
  fetch: fetchMock as unknown as typeof fetch,
});

afterEach(() => {
  fetchMock.mockReset();
});

describe('geelib request signing', () => {
  it('canonicalizes parameters in ascending key order with RFC1738 encoding', () => {
    expect(geelibCanonical({ sub_id: 6856, page: 1, pageSize: 20, t: 1700000000, user_mail: 'afk@example.com' }))
      .toBe('page=1&pageSize=20&sub_id=6856&t=1700000000&user_mail=afk%40example.com');
  });

  it('signs the canonical query with the documented double digest', () => {
    const canonical = geelibCanonical({ sub_id: 6856, page: 1, pageSize: 20, t: 1700000000, user_mail: 'afk@example.com' });
    // Reference implementation (geelib-cli api-call.py) golden value.
    expect(geelibSign(canonical, 'afk-test-token')).toBe('55a4b3d0016dc7bb65331f9b41729b3a');
    expect(createHash('md5').update('anything').digest()).toBeDefined();
  });

  it('sends reads as signed GET queries and fails closed on a platform error', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 4001, errmsg: '签名错误', data: [] }), { status: 200 }));

    await expect(client().listIssues()).rejects.toThrow('签名错误');

    const request = fetchMock.mock.calls[0]?.[0] as string;
    const url = new URL(request);
    expect(url.origin + url.pathname).toBe('https://geelib.example/openapi/Matter/getList');
    expect(url.searchParams.get('sub_id')).toBe('6856');
    expect(url.searchParams.get('user_mail')).toBe('afk@example.com');
    expect(url.searchParams.get('sign')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('geelib work item reads', () => {
  it('maps a Matter list page into tracked issues', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('Matter/getMatterStatus')) {
        return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: [
          { id: 46, status_name: '修复中', status_stage: '进行中' },
          { id: 20, status_name: '关闭', status_stage: '已完成' },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
        total: 2,
        matterList: [
          { id: 1083121, sub_id: 6856, type_id: 20655, title: '第一个工作项', mkd_content: '正文', matter_status: 46, label_name: 'BugTrace,loop' },
          { id: 1083399, sub_id: 6856, type_id: 20655, title: '已关闭项', mkd_content: '', matter_status: 20, label_name: '' },
        ],
      } }), { status: 200 });
    });

    const issues: TrackedIssue[] = await client().listIssues();

    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      id: 1083121,
      platform: 'geelib',
      title: '第一个工作项',
      description: '正文',
      state: 'opened',
      projectId: '6856',
    });
    expect(issues[0].labels).toEqual(['BugTrace', 'loop']);
    expect(issues[1].state).toBe('closed');
  });

  it('reads one matter by id and names the provider host', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('Matter/getMatterStatus')) {
        return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: [
          { id: 1, status_name: '新建', status_stage: '未开始' },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
        total: 1,
        matterList: [{ id: 1083121, sub_id: 6856, type_id: 20655, title: '单个', mkd_content: '', matter_status: 1, label_name: '' }],
      } }), { status: 200 });
    });

    const issue = await client().getIssue(1083121);

    expect(issue).toMatchObject({ id: 1083121, platform: 'geelib', state: 'opened' });
    expect(client().providerHost).toBe('geelib.example');
  });

  it('filters issues by label when the caller asks for one', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('Matter/getMatterStatus')) {
        return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
        total: 2,
        matterList: [
          { id: 1, sub_id: 6856, type_id: 20655, title: '带标签', matter_status: 1, label_name: 'BugTrace' },
          { id: 2, sub_id: 6856, type_id: 20655, title: '无标签', matter_status: 1, label_name: '' },
        ],
      } }), { status: 200 });
    });

    const issues = await client().listIssues({ labels: ['BugTrace'] });

    expect(issues.map(issue => issue.id)).toEqual([1]);
  });
});

describe('geelib unsupported capabilities', () => {
  it('refuses write and code-hosting capabilities with a clear error', async () => {
    const geelib = client();
    await expect(geelib.createIssue({ title: 'x' })).rejects.toThrow(/geelib provider does not support/i);
    await expect(geelib.createMR({ title: 'x', sourceBranch: 'a', targetBranch: 'b' })).rejects.toThrow(/geelib provider does not support/i);
    await expect(geelib.uploadArtifacts('/tmp')).rejects.toThrow(/geelib provider does not support/i);
  });
});
