import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeelibBacklogProvider } from './backlog-provider.js';
import { GeelibClient } from './client.js';
import type { GeelibStateMappingEntry } from './state-mapping-resolver.js';
import type { ClaimLease } from '../../domain/backlog/claim.js';
import type { NewReworkRecord, ReworkRecord, ReworkRevision } from '../../domain/backlog/index.js';

const fetchMock = vi.fn();
const matter = {
  id: 1083121, sub_id: 6856, type_id: 20655, type_name: '缺陷', title: '集酷工作项', mkd_content: '正文',
  matter_status: 1, label_name: '', update_time: '2026-11-15 10:00:00',
};
const dependencyMatter = {
  id: 1083000, sub_id: 6856, type_id: 20655, type_name: '缺陷', title: '依赖项', mkd_content: '',
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
let provisionedTags = [
  'billing', 'mode::afk', 'mode::hitl',
  'stage::ready', 'stage::afk-in-progress', 'stage::verification', 'stage::merge-ready',
  'stage::done', 'stage::blocked', 'stage::rework', 'kind::prd',
];
/** The matter-silo comments the fake platform answers with; rework tests seed it. */
let comments: Array<{ id: string; content: string }> = [];

/** The Matter/edit body that carried the named custom field, if any. */
function editBodyFor(cfName: string): any | undefined {
  for (const [url, init] of fetchMock.mock.calls) {
    if (!String(url).endsWith('Matter/edit')) continue;
    const body = JSON.parse(String(init?.body));
    const entry = (body.data ?? []).find((e: { cf_name?: string }) => e.cf_name === cfName);
    if (entry) return body;
  }
  return undefined;
}

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
    if (url.pathname.endsWith('OpenApiCreateTagAndModule/getSubTags')) {
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
        count: provisionedTags.length,
        list: provisionedTags.map((name, index) => ({ id: 9000 + index, name })),
      } }), { status: 200 });
    }
    if (url.pathname.endsWith('OpenApiResourcesMgr/getDemandReourcesList')) {
      return new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: {
        matter: resourceRefs, list: [],
      } }), { status: 200 });
    }
    if (url.pathname.endsWith('OpenApiCommentMgr/getList')) {
      // The platform answers in the comment silo the query names; AFK reads
      // the `matter` silo. The list is chronological (oldest first).
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: comments }), { status: 200 });
    }
    if (url.pathname.endsWith('OpenApiCommentMgr/addComment')) {
      const body = JSON.parse(String(init?.body));
      comments.push({ id: `c${comments.length + 1}`, content: String(body.content) });
      return new Response(JSON.stringify({ errno: 2000, errmsg: '添加评论成功', data: '' }), { status: 200 });
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
  provisionedTags = [
    'billing', 'mode::afk', 'mode::hitl',
    'stage::ready', 'stage::afk-in-progress', 'stage::verification', 'stage::merge-ready',
    'stage::done', 'stage::blocked', 'stage::rework', 'kind::prd',
  ];
  statuses = [...BASE_STATUSES];
  comments = [];
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

  it('carries the derived branch name the change association scopes by', async () => {
    // Hybrid mode: the item's branches and change requests live on the git
    // platform, so the association scope (`<branch>`/`<branch>-qa`) must name
    // the branch AFK actually works on, exactly like the other projections.
    mockPlatform();
    const provider = new GeelibBacklogProvider(client());

    const item = await provider.get('geelib:6856#1083121');

    expect(item.branchName).toBe('afk/backlog-1083121');
  });

  it('resolves the bare provider-local issue number the managed execution request uses', async () => {
    // `afk run` addresses the item through the manifest's providerBacklogId —
    // the bare issue number. It must resolve inside the project the client
    // already serves, on every port the execution touches.
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const item = await provider.get('1083121');
    expect(item.id).toBe('geelib:6856#1083121');

    const claim = await provider.claim('1083121', 'worker-1');
    expect(claim?.item.id).toBe('geelib:6856#1083121');
    await expect(provider.transition('1083121', 'merge_ready', { changeId: '5' })).resolves.toBeUndefined();
    await expect(provider.setExecutionMode('1083121', 'afk')).resolves.toBeUndefined();
    matter.matter_status = 1;
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

  it('drives an unmapped-type item through the stage-tag channel', async () => {
    // The tag channel supersedes decision ①: with the stage tags provisioned,
    // a 需求-type item (custom native vocabulary) is claimable and drivable —
    // the native status move is best-effort, the tag is the AFK truth.
    statuses = [
      { id: 900, status_name: '待评审', status_stage: '未开始' },
      { id: 901, status_name: '已完成', status_stage: '已完成' },
    ];
    mockPlatform();
    matter.type_id = 20651;
    matter.matter_status = 900;
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const claim = await provider.claim('geelib:6856#1083121', 'worker-1');

    expect(claim).not.toBeNull();
    expect(claim?.item.state).toBe('in_progress');
    const labelBody = editBodyFor('标签');
    expect(JSON.parse(labelBody.data.find((e: { cf_name?: string }) => e.cf_name === '标签').cf_value)).toContain('stage::afk-in-progress');
    matter.type_id = 20655;
    matter.matter_status = 1;
  });

  it('moves the native state best-effort when the type does not define the name', async () => {
    // The 缺陷 name 修复中 does not exist in the 需求 workflow: the stage tag
    // (the AFK truth) still lands, and the native move is skipped without
    // failing the transition.
    statuses = [
      { id: 900, status_name: '待评审', status_stage: '未开始' },
      { id: 901, status_name: '已完成', status_stage: '已完成' },
    ];
    mockPlatform();
    matter.type_id = 20651;
    matter.matter_status = 900;
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });
    fetchMock.mockClear();
    mockPlatform();

    await provider.transition('geelib:6856#1083121', 'in_progress');

    expect(editBodyFor('标签')).toBeDefined();
    expect(editBodyFor('状态')).toBeUndefined();
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
    provisionedTags = [
    'billing', 'mode::afk', 'mode::hitl',
    'stage::ready', 'stage::afk-in-progress', 'stage::verification', 'stage::merge-ready',
    'stage::done', 'stage::blocked', 'stage::rework', 'kind::prd',
  ];
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

  it('keeps the transition alive when the native move is refused', async () => {
    // 关闭 is unreachable through the API (verified live): the stage tag —
    // the AFK truth — still lands, the refusal is non-fatal, and the done
    // confirmation comment is written.
    mockPlatform();
    matter.matter_status = 23; // 已验证
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('Matter/edit')) {
        const body = JSON.parse(String(init?.body));
        const statusEntry = (body.data ?? []).find((e: { cf_name?: string }) => e.cf_name === '状态');
        if (statusEntry) {
          if (statusEntry.cf_value === '关闭') {
            return new Response(JSON.stringify({ errno: 5001, errmsg: '无法流转到此状态，请刷新页面后重新选择', data: '' }), { status: 200 });
          }
          matter.matter_status = statuses.find(s => s.status_name === statusEntry.cf_value)?.id ?? matter.matter_status;
          return new Response(JSON.stringify({ errno: 2000, errmsg: '批量编辑工作项成功', data: '' }), { status: 200 });
        }
        const labelEntry = (body.data ?? []).find((e: { cf_name?: string }) => e.cf_name === '标签');
        if (labelEntry) {
          matter.label_name = (JSON.parse(labelEntry.cf_value) as string[]).filter(t => provisionedTags.includes(t)).join(',');
          return new Response(JSON.stringify({ errno: 2000, errmsg: '批量编辑工作项成功', data: '' }), { status: 200 });
        }
        return new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: '' }), { status: 200 });
      }
      if (url.pathname.endsWith('OpenApiCommentMgr/addComment')) {
        return new Response(JSON.stringify({ errno: 2000, errmsg: '操作成功', data: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: { total: 1, matterList: [matter] } }), { status: 200 });
    });

    await provider.transition('geelib:6856#1083121', 'done', { changeId: '159' });

    expect(matter.label_name).toContain('stage::done');
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

describe('GeelibBacklogProvider tag state channel', () => {
  it('reads the AFK state from the stage tag before the native name', async () => {
    mockPlatform();
    // 需求-type matter whose native status is 待评审 (未开始), but AFK's tag
    // already says verification: the tag is the authority.
    statuses = [
      { id: 900, status_name: '待评审', status_stage: '未开始' },
    ];
    matter.type_id = 20651;
    matter.matter_status = 900;
    matter.label_name = 'stage::verification';
    const provider = new GeelibBacklogProvider(client());

    const item = await provider.get('geelib:6856#1083121');

    expect(item.state).toBe('verification');
    expect(item.labeledState).toBe('verification');
    matter.type_id = 20655;
    matter.matter_status = 1;
    matter.label_name = '';
  });

  it('refuses to claim when the project lacks the stage vocabulary', async () => {
    mockPlatform();
    provisionedTags = ['billing']; // no stage tags provisioned
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await expect(provider.claim('geelib:6856#1083121', 'worker-1'))
      .rejects.toThrow(/missing the AFK state tags/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('Matter/edit'))).toBe(false);
    provisionedTags = ['billing', 'mode::afk', 'mode::hitl',
      'stage::ready', 'stage::afk-in-progress', 'stage::verification', 'stage::merge-ready',
      'stage::done', 'stage::blocked', 'stage::rework', 'kind::prd'];
  });

  it('marks a PRD anchor with the kind tag', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.applyRole('geelib:6856#1083121', 'prd');

    const labelBody = editBodyFor('标签');
    expect(JSON.parse(labelBody.data.find((e: { cf_name?: string }) => e.cf_name === '标签').cf_value)).toContain('kind::prd');
    matter.label_name = 'kind::prd';
    expect((await provider.get('geelib:6856#1083121')).kind).toBe('prd');
    matter.label_name = '';
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

/**
 * The 需求 workflow of the reference project — names the static map does
 * not know, so a configured mapping is the only way AFK can drive it.
 */
const DEMAND_STATUSES = [
  { id: 900, status_name: '待处理', status_stage: '进行中' },
  { id: 901, status_name: '编码中', status_stage: '进行中' },
  { id: 902, status_name: '已接受', status_stage: '已完成' },
  { id: 903, status_name: '已上线', status_stage: '已完成' },
  { id: 904, status_name: '暂停', status_stage: '进行中' },
];

const demandMapping: GeelibStateMappingEntry = {
  project: 6856,
  type: '需求',
  states: { ready: '待处理', in_progress: '编码中', done: '已上线', blocked: '暂停' },
};

/** Point the fixture matter at the 需求 type and restore 缺陷 afterwards. */
async function asDemandType(run: () => Promise<void>): Promise<void> {
  matter.type_id = 20651;
  matter.type_name = '需求';
  try {
    await run();
  } finally {
    matter.type_id = 20655;
    matter.type_name = '缺陷';
    matter.matter_status = 1;
  }
}

describe('GeelibBacklogProvider configured state mapping', () => {
  it('writes the configured native name when an item of the mapped type transitions', async () => {
    // The 需求 workflow has no 修复中: without the mapping the write gate
    // refuses. With it, in_progress resolves to the type's own 编码中.
    statuses = DEMAND_STATUSES;
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { mappings: [demandMapping], claimLock: lock() as never });
    await asDemandType(async () => {
      matter.matter_status = 900; // 待处理

      await provider.transition('geelib:6856#1083121', 'in_progress');

      const edit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/edit'));
      expect(JSON.parse(String(edit?.[1]?.body)).data).toEqual([{ cf_name: '状态', cf_value: '编码中' }]);
    });
  });

  it('keeps the write gate fail-closed when a configured name is outside the type vocabulary', async () => {
    statuses = DEMAND_STATUSES;
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), {
      mappings: [{ project: 6856, type: '需求', states: { in_progress: '不存在的状态' } }],
      claimLock: lock() as never,
    });
    await asDemandType(async () => {
      matter.matter_status = 900;

      await expect(provider.transition('geelib:6856#1083121', 'in_progress')).rejects.toThrow(/does not define native state 不存在的状态/);
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('Matter/edit'))).toBe(false);
    });
  });

  it('maps a configured native name on the read path instead of the generic stage', async () => {
    // 待处理 sits in the platform's generic 进行中 stage, which the stage
    // fallback alone would render as in_progress. The configured mapping is
    // the more specific truth: the item is claimable ready.
    statuses = DEMAND_STATUSES;
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { mappings: [demandMapping] });
    await asDemandType(async () => {
      matter.matter_status = 900;

      const item = await provider.get('geelib:6856#1083121');

      expect(item.state).toBe('ready');
      expect(item.labeledState).toBe('ready');
      expect(item.executionEligible).toBe(true);
    });
  });

  it('resolves the verified static map before the configuration (a before b)', async () => {
    // A misconfigured entry for the 缺陷 type must not move AFK off the
    // live-verified workflow: the static map wins for names it knows.
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), {
      mappings: [{ project: 6856, type: '缺陷', states: { in_progress: '重新打开' } }],
      claimLock: lock() as never,
    });

    await provider.transition('geelib:6856#1083121', 'in_progress');

    const edit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/edit'));
    expect(JSON.parse(String(edit?.[1]?.body)).data).toEqual([{ cf_name: '状态', cf_value: '修复中' }]);
  });

  it('keeps the current behavior for an unconfigured project+type', async () => {
    // The mapping covers 需求 only: a 任务 item (another type, same project)
    // still falls back to the generic stage for display and stays read-only.
    statuses = DEMAND_STATUSES;
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { mappings: [demandMapping] });
    matter.type_id = 20700;
    matter.type_name = '任务';
    try {
      matter.matter_status = 900; // 待处理, a name the mapping does not cover for 任务

      const item = await provider.get('geelib:6856#1083121');
      expect(item.state).toBe('in_progress'); // stage fallback, display only
      expect(item.executionEligible).toBe(false);
    } finally {
      matter.type_id = 20655;
      matter.type_name = '缺陷';
      matter.matter_status = 1;
    }
  });

  it('skips the status write when the item already sits in the configured target', async () => {
    statuses = DEMAND_STATUSES;
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { mappings: [demandMapping], claimLock: lock() as never });
    await asDemandType(async () => {
      matter.matter_status = 901; // 编码中

      await provider.transition('geelib:6856#1083121', 'in_progress');

      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('Matter/edit'))).toBe(false);
    });
  });

  it('loads the mapping file the options name', async () => {
    statuses = DEMAND_STATUSES;
    mockPlatform();
    const dir = mkdtempSync(join(tmpdir(), 'afk-geelib-provider-'));
    try {
      const path = join(dir, 'mappings.yml');
      writeFileSync(path, [
        'mappings:',
        '  - project: 6856',
        '    type: 需求',
        '    states:',
        '      in_progress: 编码中',
      ].join('\n'));
      const provider = new GeelibBacklogProvider(client(), { mappingsPath: path, claimLock: lock() as never });
      await asDemandType(async () => {
        matter.matter_status = 900;

        await provider.transition('geelib:6856#1083121', 'in_progress');

        const edit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('Matter/edit'));
        expect(JSON.parse(String(edit?.[1]?.body)).data).toEqual([{ cf_name: '状态', cf_value: '编码中' }]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Rework records ──────────────────────────────────────────────────────────
//
// The comment protocol, written literally here so the tests pin the wire
// format and not just the implementation: a state marker plus a data marker
// inside HTML comments (never rendered), then a human-readable body.

const stateMarker = (id: string, state: string): string => `<!-- afk:rework:${id}:${state} -->`;
const dataMarker = (id: string, payload: unknown): string => `<!-- afk:rework:${id}:data:${JSON.stringify(payload)} -->`;
const openBody = (record: ReworkRecord): string => `${stateMarker(record.id, 'open')}\n${dataMarker(record.id, record)}\n<p>AFK 返工记录 ${record.id}</p>`;
const resolvedBody = (id: string, summary: string): string => `${stateMarker(id, 'resolved')}\n${dataMarker(id, { resolvedAt: '2026-11-15T11:00:00.000Z', summary })}\n<p>AFK 返工完成：${summary}</p>`;
const supersededBody = (id: string): string => `${stateMarker(id, 'superseded')}\n<p>AFK 返工记录 ${id} 已被取代</p>`;
const revisionBody = (id: string, revision: ReworkRevision): string => `${stateMarker(id, 'revision')}\n${dataMarker(id, revision)}\n<p>AFK 返工更正 ${id}</p>`;

function seedComments(...bodies: string[]): void {
  // The platform payload shape `GeelibClient.listComments` decodes: `content`
  // is the comment body, the silo is `matter`.
  comments = bodies.map((body, index) => ({ id: `seed-${index + 1}`, body: '', author: 'AFK', time: '2026-11-15 10:00:00', content: body }));
}

/** The comment bodies this test run wrote through addComment, in order. */
function writtenCommentBodies(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('OpenApiCommentMgr/addComment'))
    .map(([, init]) => JSON.parse(String(init?.body)).content as string);
}

/** The data payload a written comment carries for one record id. */
function writtenData(body: string, id: string): ReworkRecord {
  const match = new RegExp(`<!-- afk:rework:${id}:data:([\\s\\S]*?)\\s*-->`).exec(body);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as ReworkRecord;
}

const seededRecord = (overrides: Partial<ReworkRecord> = {}): ReworkRecord => ({
  version: 1,
  id: 'r1-1',
  cycle: 1,
  attempt: 1,
  status: 'open',
  source: 'qa',
  summary: '断言失败：期望 2 实际 1',
  failedCriteria: [{ id: 'ac-1', expected: '2', actual: '1' }],
  requiredChecks: [{ command: 'pnpm test', expected: 'all green' }],
  createdAt: '2026-11-15T10:00:00.000Z',
  ...overrides,
});

describe('GeelibBacklogProvider rework records', () => {
  it('writes the rework record as an open-marker comment without touching the state machine', async () => {
    // QA routes the rework state itself (`transition('rework', {reason})` at
    // the call site), so createRework must not transition: one record
    // comment, no status edit.
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });
    const input: NewReworkRecord = {
      source: 'qa', summary: '断言失败：期望 2 实际 1',
      failedCriteria: [{ id: 'ac-1', expected: '2', actual: '1' }],
      requiredChecks: [{ command: 'pnpm test', expected: 'all green' }],
    };

    const record = await provider.createRework('geelib:6856#1083121', input);

    expect(record).toMatchObject({ version: 1, id: 'r1-1', cycle: 1, attempt: 1, status: 'open', source: 'qa' });
    const bodies = writtenCommentBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(stateMarker('r1-1', 'open'));
    const payload = writtenData(bodies[0], 'r1-1');
    expect(payload).toMatchObject({
      version: 1, id: 'r1-1', cycle: 1, attempt: 1, status: 'open', source: 'qa',
      summary: '断言失败：期望 2 实际 1',
      failedCriteria: [{ id: 'ac-1', expected: '2', actual: '1' }],
      requiredChecks: [{ command: 'pnpm test', expected: 'all green' }],
    });
    expect(bodies[0]).toContain('<p>断言失败：期望 2 实际 1</p>');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('Matter/edit'))).toBe(false);
  });

  it('escapes the human-readable body but keeps the payload intact', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.createRework('geelib:6856#1083121', {
      source: 'qa', summary: 'a --> b <b>加粗</b>', failedCriteria: [], requiredChecks: [],
    });

    const body = writtenCommentBodies()[0];
    expect(body).toContain('&lt;b&gt;加粗&lt;/b&gt;'); // human part is escaped
    const payload = writtenData(body, 'r1-1');
    expect(payload).toMatchObject({ summary: 'a --> b <b>加粗</b>' }); // machine part round-trips
  });

  it('numbers the next attempt inside the running cycle from the comment history', async () => {
    mockPlatform();
    seedComments(openBody(seededRecord()), resolvedBody('r1-1', 'QA passed after rework r1-1.'));
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const record = await provider.createRework('geelib:6856#1083121', {
      source: 'qa', summary: '再次失败', failedCriteria: [], requiredChecks: [],
    });

    expect(record).toMatchObject({ id: 'r1-2', cycle: 1, attempt: 2 });
  });

  it('opens a new cycle for an operator retry and routes the item to rework', async () => {
    // The operator retry command relies on the provider to move the item out
    // of blocked+hitl — the QA/conflict paths transition at their own call
    // sites, the operator path does not.
    mockPlatform();
    seedComments(openBody(seededRecord()), resolvedBody('r1-1', 'closed by the operator retry'));
    matter.matter_status = 24; // 延期 (blocked)
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const record = await provider.createRework('geelib:6856#1083121', {
      source: 'operator', summary: '依赖已就绪，重试', failedCriteria: [], requiredChecks: [],
    });

    expect(record).toMatchObject({ id: 'r2-0', cycle: 2, attempt: 0 });
    const edits = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('Matter/edit')).map(([, init]) => JSON.parse(String(init?.body)));
    expect(edits.some(edit => edit.data?.some((entry: { cf_name: string; cf_value: string }) => entry.cf_name === '状态' && entry.cf_value === '重新打开'))).toBe(true);
    matter.matter_status = 1;
  });

  it('refuses a second operator record while one is open', async () => {
    mockPlatform();
    seedComments(openBody(seededRecord({ source: 'operator', id: 'r2-0', cycle: 2, attempt: 0 })));
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await expect(provider.createRework('geelib:6856#1083121', {
      source: 'operator', summary: '又一次重试', failedCriteria: [], requiredChecks: [],
    })).rejects.toThrow(/already has an open rework record/);
  });

  it('supersedes an open record when the next attempt is written', async () => {
    // Append-only platform: the previous record is not edited (there is no
    // comment-edit call); a superseded marker is appended after the new one.
    mockPlatform();
    seedComments(openBody(seededRecord()));
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const record = await provider.createRework('geelib:6856#1083121', {
      source: 'qa', summary: '换个修法再试', failedCriteria: [], requiredChecks: [],
    });

    expect(record.id).toBe('r1-2');
    const bodies = writtenCommentBodies();
    expect(bodies[0]).toContain(stateMarker('r1-2', 'open'));
    expect(bodies[1]).toContain(stateMarker('r1-1', 'superseded'));

    const active = await provider.getActiveRework('geelib:6856#1083121');
    expect(active?.id).toBe('r1-2');
  });

  it('reads the latest open record back from the comments', async () => {
    mockPlatform();
    seedComments(
      openBody(seededRecord()),
      resolvedBody('r1-1', 'QA passed after rework r1-1.'),
      openBody(seededRecord({ id: 'r1-2', attempt: 2, summary: '第二次失败' })),
    );
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const active = await provider.getActiveRework('geelib:6856#1083121');

    expect(active).toMatchObject({
      id: 'r1-2', cycle: 1, attempt: 2, status: 'open', source: 'qa', summary: '第二次失败',
      failedCriteria: [{ id: 'ac-1', expected: '2', actual: '1' }],
    });
  });

  it('keeps a resolved record inactive', async () => {
    mockPlatform();
    seedComments(openBody(seededRecord()), resolvedBody('r1-1', 'QA passed after rework r1-1.'));
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    expect(await provider.getActiveRework('geelib:6856#1083121')).toBeUndefined();
  });

  it('folds revisions into the record they correct', async () => {
    mockPlatform();
    seedComments(
      openBody(seededRecord({ summary: '把依赖写成了 label' })),
      revisionBody('r1-1', { at: '2026-11-15T12:00:00.000Z', actor: 'operator', from: '把依赖写成了 label', to: '依赖已发布，等待验证' }),
    );
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const active = await provider.getActiveRework('geelib:6856#1083121');

    expect(active).toMatchObject({
      id: 'r1-1', status: 'open', summary: '依赖已发布，等待验证',
      revisions: [{ at: '2026-11-15T12:00:00.000Z', actor: 'operator', from: '把依赖写成了 label', to: '依赖已发布，等待验证' }],
    });
  });

  it('appends a resolved comment and closes the record', async () => {
    mockPlatform();
    seedComments(openBody(seededRecord()));
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await provider.resolveRework('geelib:6856#1083121', 'r1-1', { summary: 'QA passed after rework r1-1.' });

    const body = writtenCommentBodies()[0];
    expect(body).toContain(stateMarker('r1-1', 'resolved'));
    expect(body).toContain('QA passed after rework r1-1.');
    expect(await provider.getActiveRework('geelib:6856#1083121')).toBeUndefined();
  });

  it('refuses to resolve an unknown or already-closed record', async () => {
    mockPlatform();
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });
    await expect(provider.resolveRework('geelib:6856#1083121', 'r1-1', { summary: 'x' }))
      .rejects.toThrow(/open rework record not found/);

    seedComments(openBody(seededRecord()), resolvedBody('r1-1', 'already resolved'));
    await expect(provider.resolveRework('geelib:6856#1083121', 'r1-1', { summary: 'x' }))
      .rejects.toThrow(/open rework record not found/);
  });

  it('appends a correction that keeps the record identity and the evidence', async () => {
    mockPlatform();
    seedComments(openBody(seededRecord()));
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    const revised = await provider.reviseRework('geelib:6856#1083121', 'r1-1', {
      summary: '目标分支已包含该变更，无需合并', actor: 'operator', reason: '冲突已消失',
    });

    expect(revised).toMatchObject({
      id: 'r1-1', status: 'open', summary: '目标分支已包含该变更，无需合并',
      failedCriteria: [{ id: 'ac-1', expected: '2', actual: '1' }],
      revisions: [{ actor: 'operator', from: '断言失败：期望 2 实际 1', to: '目标分支已包含该变更，无需合并', reason: '冲突已消失' }],
    });
    const body = writtenCommentBodies()[0];
    expect(body).toContain(stateMarker('r1-1', 'revision'));
    expect(writtenData(body, 'r1-1')).toMatchObject({ from: '断言失败：期望 2 实际 1', to: '目标分支已包含该变更，无需合并' });

    const active = await provider.getActiveRework('geelib:6856#1083121');
    expect(active?.summary).toBe('目标分支已包含该变更，无需合并');
  });

  it('refuses to revise a record that is not open', async () => {
    mockPlatform();
    seedComments(openBody(seededRecord()), resolvedBody('r1-1', 'resolved'));
    const provider = new GeelibBacklogProvider(client(), { claimLock: lock() as never });

    await expect(provider.reviseRework('geelib:6856#1083121', 'r1-1', { summary: '依赖已发布', actor: 'operator' }))
      .rejects.toThrow(/open rework record not found/);
  });
});
