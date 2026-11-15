import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeelibBacklogProvider } from './backlog-provider.js';
import { GeelibClient } from './client.js';
import type { ClaimLease } from '../../domain/backlog/claim.js';

const fetchMock = vi.fn();
const matter = {
  id: 1083121, sub_id: 6856, type_id: 20655, title: '集酷工作项', mkd_content: '正文',
  matter_status: 1, label_name: '', update_time: '2026-11-15 10:00:00',
};
const statuses = [
  { id: 1, status_name: '新建', status_stage: '未开始' },
  { id: 46, status_name: '修复中', status_stage: '进行中' },
  { id: 20, status_name: '关闭', status_stage: '已完成' },
];

function mockPlatform(): void {
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('Matter/getMatterStatus')) {
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: statuses }), { status: 200 });
    }
    if (url.pathname.endsWith('Matter/edit')) {
      // A real edit moves the native status; the confirmation read must see it.
      const body = JSON.parse(String(init?.body));
      const requested = body.data?.find((entry: { cf_name?: string }) => entry.cf_name === '状态')?.cf_value;
      matter.matter_status = statuses.find(status => status.status_name === requested)?.id ?? matter.matter_status;
      return new Response(JSON.stringify({ errno: 2000, errmsg: '批量编辑工作项成功', data: '' }), { status: 200 });
    }
    return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: {
      total: 1, matterList: [matter],
    } }), { status: 200 });
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
