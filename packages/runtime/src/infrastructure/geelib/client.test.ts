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

  it('encodes the flattened array keys as well as the values', () => {
    // Verified live: the server validates the encoded form, and a key left
    // raw fails the signature check (errno 4001).
    expect(geelibCanonical({ sub_id: 6856, matter_ids: [322370], t: 1700000000, user_mail: 'afk@example.com' }))
      .toBe('matter_ids%5B0%5D=322370&sub_id=6856&t=1700000000&user_mail=afk%40example.com');
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

describe('geelib catalog reads', () => {
  it('lists the projects the account can access', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
      count: 2,
      list: [
        { id: 6856, name: '示例项目', update_time: '2026-11-14 23:24:48' },
        { id: 4065, name: '另一个项目' },
      ],
    } }), { status: 200 }));

    const projects = await client().listCatalogProjects();

    expect(projects).toEqual([
      { id: 6856, name: '示例项目', updatedAt: '2026-11-14 23:24:48' },
      { id: 4065, name: '另一个项目', updatedAt: undefined },
    ]);
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/openapi/OpenApiSubBusMgr/getSubBusList');
  });

  it('lists catalog issues of one project with native state and update time', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('Matter/getMatterStatus')) {
        return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: [
          { id: 1, status_name: '新建', status_stage: '未开始' },
          { id: 20, status_name: '关闭', status_stage: '已完成' },
        ] }), { status: 200 });
      }
      expect(url.searchParams.get('sub_id')).toBe('4065');
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
        total: 2,
        matterList: [
          { id: 11, sub_id: 4065, type_id: 20655, title: '打开的', matter_status: 1, label_name: 'BugTrace', update_time: '2026-11-15 10:00:00' },
          { id: 12, sub_id: 4065, type_id: 20655, title: '完成的', matter_status: 20, label_name: '', update_time: '2026-11-15 11:00:00' },
        ],
      } }), { status: 200 });
    });

    const issues = await client().listCatalogIssues(4065);

    expect(issues).toEqual([
      { issueNumber: 11, title: '打开的', description: '', labels: ['BugTrace'], state: 'opened', updatedAt: '2026-11-15 10:00:00', webUrl: 'https://geelib.example/geelib/project/matter/detail?subId=4065&id=11' },
      { issueNumber: 12, title: '完成的', description: '', labels: [], state: 'closed', updatedAt: '2026-11-15 11:00:00', webUrl: 'https://geelib.example/geelib/project/matter/detail?subId=4065&id=12' },
    ]);
  });

  it('resolves the account identity by searching its own mail', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
      count: 2,
      list: [
        { id: 73, mail: 'afk@example.com', real_name: 'AFK' },
        { id: 74, mail: 'other@example.com', real_name: 'Other' },
      ],
    } }), { status: 200 }));

    expect(await client().accountIdentity()).toEqual({ accountId: '73' });
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/openapi/UserMgr/getUserListBySearch');
    expect(url.searchParams.get('query')).toBe('afk@example.com');
  });

  it('refuses an account identity when the search does not match the configured mail', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
      count: 1,
      list: [{ id: 74, mail: 'other@example.com' }],
    } }), { status: 200 }));

    await expect(client().accountIdentity()).rejects.toThrow(/afk@example\.com/);
  });
});

describe('geelib write methods', () => {
  it('edits a work item status through the documented edit call', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '批量编辑工作项成功', data: '' }), { status: 200 }));

    await client().setStatus(1083121, '修复中');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://geelib.example/openapi/Matter/edit');
    const body = JSON.parse(String(init.body));
    expect(body.id).toBe(1083121);
    expect(body.sub_id).toBe(6856);
    expect(body.data).toEqual([{ cf_name: '状态', cf_value: '修复中' }]);
    expect(body.t).toBeGreaterThan(0);
    expect(body.user_mail).toBe('afk@example.com');
    expect(body.sign).toMatch(/^[0-9a-f]{32}$/);
  });

  it('replaces the label set with the JSON-string payload the platform expects', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '批量编辑工作项成功', data: '' }), { status: 200 }));

    await client().setLabels(1083121, ['billing', 'mode::hitl']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://geelib.example/openapi/Matter/edit');
    const body = JSON.parse(String(init.body));
    expect(body.data).toEqual([{ cf_name: '标签', cf_value: '["billing","mode::hitl"]' }]);
  });

  it('lists the comments of a work item from the requested silo', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '', data: [
      { id: '1390431', content: '<p>AFK 已认领</p>', create_by_name: '盛纲舒', create_time: '2026-11-16 10:00:00' },
    ] }), { status: 200 }));

    const comments = await client().listComments(1083121, 'bug');

    expect(comments).toEqual([{ id: '1390431', body: '<p>AFK 已认领</p>', author: '盛纲舒', time: '2026-11-16 10:00:00' }]);
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/openapi/OpenApiCommentMgr/getList');
    expect(url.searchParams.get('sub_id')).toBe('6856');
    expect(url.searchParams.get('type')).toBe('bug');
    expect(url.searchParams.get('id')).toBe('1083121');
  });

  it('refuses a status outside the verified native vocabulary', async () => {
    await expect(client().setStatus(1083121, '随便写的')).rejects.toThrow(/native state/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appends a comment as an HTML rich-text block', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: 1 }), { status: 200 }));

    await client().addComment(1083121, '<p>AFK 已认领</p>');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://geelib.example/openapi/OpenApiCommentMgr/addComment');
    const body = JSON.parse(String(init.body));
    expect(body.sub_id).toBe(6856);
    expect(body.id).toBe(1083121);
    expect(body.type).toBe('matter');
    expect(body.content).toBe('<p>AFK 已认领</p>');
    expect(body.sign).toMatch(/^[0-9a-f]{32}$/);
  });

  it('surfaces a platform error from a write as a readable failure', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 5001, errmsg: '无法流转到此状态，请刷新页面后重新选择', data: '' }), { status: 200 }));

    await expect(client().setStatus(1083121, '关闭')).rejects.toThrow('无法流转到此状态');
  });
});

describe('geelib relation channel', () => {
  it('points a work item at a native parent', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: '' }), { status: 200 }));

    await client().changeParent(1083121, 1083000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://geelib.example/openapi/Matter/changeParent');
    const body = JSON.parse(String(init.body));
    expect(body.id).toBe(1083121);
    expect(body.parent_id).toBe(1083000);
    expect(body.sub_id).toBe(6856);
  });

  it('adds resource references with the data payload signed as a JSON string', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: 1 }), { status: 200 }));

    await client().addResourceReferences(1083121, [{ id: 1083000, title: '依赖项', subId: 6856 }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://geelib.example/openapi/OpenApiResourcesMgr/addResources');
    const body = JSON.parse(String(init.body));
    expect(body.id).toBe(1083121);
    expect(body.source).toBe('matter');
    // The server signs `data` as one string parameter: the nested object form
    // fails the signature check (errno 4001, verified live).
    expect(typeof body.data).toBe('string');
    expect(JSON.parse(body.data)).toEqual({ matter: [{ id: 1083000, title: '依赖项', sub_id: 6856 }] });
  });

  it('lists the resource references of a work item, decoding the target matter id', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: {
      matter: [{ id: 836916, source_id: '1083121', type_id: 1083000, title: '依赖项', sub_id: '6856' }],
      list: [],
    } }), { status: 200 }));

    const references = await client().listResourceReferences(1083121);

    // `id` is the platform's reference record; the referenced work item is
    // `type_id` (verified live).
    expect(references).toEqual([{ referenceId: 836916, id: 1083000, title: '依赖项', subId: 6856 }]);
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/openapi/OpenApiResourcesMgr/getDemandReourcesList');
    expect(url.searchParams.get('id')).toBe('1083121');
    expect(url.searchParams.get('source')).toBe('matter');
  });

  it('refuses reference removal with the platform diagnosis', async () => {
    await expect(client().removeResourceReference(836916)).rejects.toThrow(/cannot delete resource references/i);
    expect(fetchMock).not.toHaveBeenCalled();
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
