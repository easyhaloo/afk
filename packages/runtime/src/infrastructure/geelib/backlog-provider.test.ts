import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeelibBacklogProvider } from './backlog-provider.js';
import { GeelibClient } from './client.js';
import type { ClaimLease } from '../../domain/backlog/claim.js';

const fetchMock = vi.fn();
const matter = {
  id: 1083121, sub_id: 6856, type_id: 20655, title: '集酷工作项', mkd_content: '正文',
  matter_status: 1, label_name: '', update_time: '2026-11-15 10:00:00',
};
const dependencyMatter = {
  id: 1083000, sub_id: 6856, type_id: 20655, title: '依赖项', mkd_content: '',
  matter_status: 1, label_name: '', update_time: '2026-11-15 09:00:00',
};
/** The complete 缺陷 workflow enum — the vocabulary AFK's mapping writes. */
const BASE_STATUSES = [
  { id: 1, status_name: '新建', status_stage: '未开始' },
  { id: 3, status_name: '重新打开', status_stage: '进行中' },
  { id: 46, status_name: '修复中', status_stage: '进行中' },
  { id: 47, status_name: '已修复', status_stage: '进行中' },
  { id: 23, status_name: '已验证', status_stage: '已完成' },
  { id: 24, status_name: '延期', status_stage: '进行中' },
  { id: 45, status_name: '已拒绝', status_stage: '进行中' },
  { id: 20, status_name: '关闭', status_stage: '已完成' },
];
let statuses = [...BASE_STATUSES];
/** Resource references the fake platform answers with; relations tests seed it. */
let resourceRefs: Array<{ id: number; source_id: string; type_id: number; title: string; sub_id: string }> = [];
/** Tags provisioned on the fake project; the platform silently drops the rest. */
let provisionedTags = ['billing', 'mode::afk', 'mode::hitl'];

function mockPlatform(): void {
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('Matter/getMatterStatus')) {
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: statuses }), { status: 200 });
    }
    if (url.pathname.endsWith('Matter/edit')) {
      // A real edit moves the native status and the label set; the
      // confirmation read must see both. A label the project does not have
      // is silently dropped — that is the platform's documented behavior.
      const body = JSON.parse(String(init?.body));
      const requested = body.data?.find((entry: { cf_name?: string }) => entry.cf_name === '状态')?.cf_value;
      matter.matter_status = statuses.find(status => status.status_name === requested)?.id ?? matter.matter_status;
      const labels = body.data?.find((entry: { cf_name?: string }) => entry.cf_name === '标签')?.cf_value;
      if (typeof labels === 'string') {
        matter.label_name = (JSON.parse(labels) as string[]).filter(tag => provisionedTags.includes(tag)).join(',');
      }
      return new Response(JSON.stringify({ errno: 2000, errmsg: '批量编辑工作项成功', data: '' }), { status: 200 });
    }
    if (url.pathname.endsWith('Matter/changeParent')) {
      return new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: '' }), { status: 200 });
    }
    if (url.pathname.endsWith('OpenApiResourcesMgr/addResources')) {
      return new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: 1 }), { status: 200 });
    }
    if (url.pathname.endsWith('OpenApiResourcesMgr/getDemandReourcesList')) {
      return new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: {
        matter: resourceRefs, list: [],
      } }), { status: 200 });
    }
    const matterIds = [...url.searchParams.entries()].filter(([key]) => key.startsWith('matter_ids')).map(([, value]) => Number(value));
    const pool = [matter, dependencyMatter];
    const found = matterIds.length ? pool.filter(entry => matterIds.includes(entry.id)) : [matter];
    return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: { total: found.length, matterList: found } }), { status: 200 });
  });
}

function client(): GeelibClient {
  // Built here so every test exercises the real signed client against the
  // mocked platform, exactly like production.
  return new GeelibClient({ baseUrl: 'https://geelib.example', userMail: 'afk@example.com', token: 'afk-test-token', subId: 6856, fetch: fetchMock as unknown as typeof fetch });
}

function lock(lease?: ClaimLease): { acquire: ReturnType<typeof vi.fn> } {
  return { acquire: vi.fn(async () => lease ?? {
    claimId: 'lease-1', heartbeat: async () => {}, release: async () => {},
  }) };
}

afterEach(() => {
  fetchMock.mockReset();
  resourceRefs = [];
  provisionedTags = ['billing', 'mode::afk', 'mode::hitl'];
  statuses = [...BASE_STATUSES];
  vi.restoreAllMocks();
});

describe('GeelibBacklogProvider mapping', () => {
  it('reads a work item as an AFK backlog item with the native state mapped', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client());

    const item = await provider.get('geelib:6856#1083121');

    expect(item).toMatchObject({
      id: 'geelib:6856#1083121',
      workItemId: 'geelib:6856#1083121',
      issueNumber: 1083121,
      title: '集酷工作项',
      description: '正文',
      state: 'ready',
      labeledState: 'ready',
      managed: true,
      executionEligible: true,
      executionMode: 'afk',
      providerRef: 'geelib:6856#1083121',
      project: { platform: 'geelib', projectKey: '6856' },
    });
    expect(item.webUrl).toContain('subId=6856');
  });

  it('maps each native status onto its AFK lifecycle position', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client());
    matter.matter_status = 46;
    expect((await provider.get('geelib:6856#1083121')).state).toBe('in_progress');
    matter.matter_status = 20;
    expect((await provider.get('geelib:6856#1083121')).state).toBe('done');
    matter.matter_status = 1;
  });

  it('falls back to the generic stage when a type customizes its status names', async () => {
    // The platform customizes status names per type/project (需求 uses
    // 待处理/规划中/已上线…). A name the mapping does not know must fall back
    // to the generic stage — 未开始→ready, 进行中→in_progress, 已完成/已关闭→done —
    // never to a claimable 'ready' for work that is actually in progress.
    mockPlatform();
    const provider = new GeelibBacklogProvider(client());
    statuses.push(
      { id: 900, status_name: '待处理', status_stage: '进行中' },
      { id: 901, status_name: '规划中', status_stage: '进行中' },
      { id: 902, status_name: '未激活', status_stage: '未开始' },
      { id: 903, status_name: '已抛弃', status_stage: '已关闭' },
    );
    const probe = (statusId: number) => {
      matter.type_id = 20651; // 需求 type with its own enum
      matter.matter_status = statusId;
      return provider.get('geelib:6856#1083121').then(item => {
        matter.type_id = 20655;
        matter.matter_status = 1;
        return item.state;
      });
    };

    expect(await probe(900)).toBe('in_progress'); // NOT claimable 'ready'
    expect(await probe(901)).toBe('in_progress');
    expect(await probe(902)).toBe('ready');
    expect(await probe(903)).toBe('done');
  });

  it('refuses to write a native status the item type does not define', async () => {
    // The 缺陷 name 修复中 does not exist in the 需求 workflow: writing it
    // must be refused before the call, not surfaced as platform errno 5001.
    statuses = [
      { id: 900, status_name: '待处理', status_stage: '进行中' },
      { id: 901, status_name: '已完成', status_stage: '已完成' },
    ];
    mockPlatform();
    matter.type_id = 20651;
    matter.matter_status = 900;
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });
    fetchMock.mockClear();
    mockPlatform();

    await expect(provider.transition('geelib:6856#1083121', 'in_progress')).rejects.toThrow(/does not define native state/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('Matter/edit'))).toBe(false);
    matter.type_id = 20655;
    matter.matter_status = 1;
  });

  it('separates business tags from reserved mode markers', async () => {
    mockPlatform();
    matter.label_name = 'billing,mode::hitl';
    const provider = new GeelibBacklogProvider(client());

    const item = await provider.get('geelib:6856#1083121');

    expect(item.tags).toEqual(['billing']);
    expect(item.executionMode).toBe('hitl');
    matter.label_name = '';
  });
});

describe('GeelibBacklogProvider claim and transition', () => {
  it('claims a ready item through the lease, moving it to in_progress', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const claim = await provider.claim('geelib:6856#1083121', 'worker-1');

    expect(claim).not.toBeNull();
    expect(claim?.item.state).toBe('in_progress');
    expect(claim?.claimId).toBe('lease-1');
    const edit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/edit'));
    expect(JSON.parse(String(edit?.[1]?.body)).data).toEqual([{ cf_name: '状态', cf_value: '修复中' }]);
  });

  it('returns null when another worker holds the lease', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock(null) as never });

    expect(await provider.claim('geelib:6856#1083121', 'worker-2')).toBeNull();
  });

  it('skips the write when the item already sits in the target state', async () => {
    mockPlatform();
    matter.matter_status = 46;
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.transition('geelib:6856#1083121', 'in_progress');

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('Matter/edit'))).toBe(false);
    matter.matter_status = 1;
  });

  it('maps transitions onto the native machine and lets its refusals surface', async () => {
    mockPlatform();
    matter.matter_status = 1;
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.transition('geelib:6856#1083121', 'in_progress');
    const edit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/edit'));
    expect(JSON.parse(String(edit?.[1]?.body)).data).toEqual([{ cf_name: '状态', cf_value: '修复中' }]);

    matter.matter_status = 23; // 已验证
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ errno: 5001, errmsg: '无法流转到此状态，请刷新页面后重新选择', data: '' }), { status: 200 }));
    await expect(provider.transition('geelib:6856#1083121', 'done')).rejects.toThrow('无法流转到此状态');
    matter.matter_status = 1;
  });
});

describe('GeelibBacklogProvider execution mode', () => {
  it('swaps the mode tag and keeps the business labels', async () => {
    mockPlatform();
    matter.label_name = 'billing,mode::afk';
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.applyMode('geelib:6856#1083121', 'hitl');

    const edit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/edit'));
    expect(JSON.parse(String(edit?.[1]?.body)).data).toEqual([{ cf_name: '标签', cf_value: '["billing","mode::hitl"]' }]);
    matter.label_name = '';
  });

  it('fails closed when the platform drops the mode tag', async () => {
    mockPlatform();
    provisionedTags = ['billing', 'mode::afk']; // mode::hitl not provisioned
    matter.label_name = 'billing';
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await expect(provider.applyMode('geelib:6856#1083121', 'hitl')).rejects.toThrow(/mode::hitl/i);
    provisionedTags = ['billing', 'mode::afk', 'mode::hitl'];
    matter.label_name = '';
  });
});

describe('GeelibBacklogProvider transition writeback', () => {
  it('appends a comment when a transition carries a reason', async () => {
    mockPlatform();
    matter.matter_status = 46; // 修复中
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.transition('geelib:6856#1083121', 'blocked', { reason: 'QA rework 9: 断言失败' });

    const comment = fetchMock.mock.calls.find(([url]) => String(url).endsWith('OpenApiCommentMgr/addComment'));
    expect(comment).toBeDefined();
    const body = JSON.parse(String(comment?.[1]?.body));
    expect(body.id).toBe(1083121);
    expect(body.type).toBe('matter');
    expect(body.content).toContain('阻塞');
    expect(body.content).toContain('QA rework 9: 断言失败');
  });

  it('names the change request when an item reaches merge_ready', async () => {
    mockPlatform();
    matter.matter_status = 47; // 已修复
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.transition('geelib:6856#1083121', 'merge_ready', { changeId: '159' });

    const comment = fetchMock.mock.calls.find(([url]) => String(url).endsWith('OpenApiCommentMgr/addComment'));
    expect(JSON.parse(String(comment?.[1]?.body)).content).toContain('#159');
  });

  it('writes the done confirmation as a comment even when the status write is skipped', async () => {
    mockPlatform();
    matter.matter_status = 23; // 已验证 — the collapse target of done
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });
    fetchMock.mockClear();
    mockPlatform();

    await provider.transition('geelib:6856#1083121', 'done', { changeId: '159' });

    const edit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/edit'));
    expect(edit).toBeUndefined(); // same native state: the write is skipped
    const comment = fetchMock.mock.calls.find(([url]) => String(url).endsWith('OpenApiCommentMgr/addComment'));
    expect(comment).toBeDefined();
    expect(JSON.parse(String(comment?.[1]?.body)).content).toContain('#159');
  });

  it('does not comment on a bare transition', async () => {
    mockPlatform();
    matter.matter_status = 1;
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });
    fetchMock.mockClear();
    mockPlatform();

    await provider.transition('geelib:6856#1083121', 'in_progress');

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('OpenApiCommentMgr/addComment'))).toBe(false);
  });
});

describe('GeelibBacklogProvider relations', () => {
  it('decodes resource references into canonical dependency identities', async () => {
    mockPlatform();
    resourceRefs = [{ id: 836916, source_id: '1083121', type_id: 1083000, title: '依赖项', sub_id: '6856' }];
    const provider = new GeelibBacklogProvider(client());

    const item = await provider.get('geelib:6856#1083121');

    expect(item.dependsOn).toEqual(['geelib:6856#1083000']);
  });

  it('adds a dependency edge by referencing the target matter', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client());

    await provider.applyRelationUpdate('geelib:6856#1083121', { addDependsOn: ['geelib:6856#1083000'] });

    const add = fetchMock.mock.calls.find(([url]) => String(url).endsWith('OpenApiResourcesMgr/addResources'));
    expect(add).toBeDefined();
    const body = JSON.parse(String(add?.[1]?.body));
    expect(body.id).toBe(1083121);
    expect(JSON.parse(body.data)).toEqual({ matter: [{ id: 1083000, title: '依赖项', sub_id: 6856 }] });
  });

  it('points a work item at its native parent', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client());

    await provider.applyRelationUpdate('geelib:6856#1083121', { parent: 'geelib:6856#1083000' });

    const parentCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/changeParent'));
    expect(parentCall).toBeDefined();
    expect(JSON.parse(String(parentCall?.[1]?.body))).toMatchObject({ id: 1083121, parent_id: 1083000, sub_id: 6856 });
  });

  it('refuses edge removal with the platform diagnosis', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client());

    await expect(provider.applyRelationUpdate('geelib:6856#1083121', { removeDependsOn: ['geelib:6856#1083000'] }))
      .rejects.toThrow(/cannot delete resource references/);
    await expect(provider.applyRelationUpdate('geelib:6856#1083121', { clearParent: true }))
      .rejects.toThrow(/cannot clear a parent/);
  });
});
