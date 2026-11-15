import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderBundle } from './providers.js';

import { GeelibClient } from '../geelib/client.js';

const fetchMock = vi.fn();
const matter = {
  id: 1083121, sub_id: 6856, type_id: 20655, title: '集酷工作项', mkd_content: '正文',
  matter_status: 1, label_name: '', update_time: '2026-11-15 10:00:00',
};

function geelibTracker(): GeelibClient {
  return new GeelibClient({ baseUrl: 'https://geelib.example', userMail: 'afk@example.com', token: 't', subId: 6856, fetch: fetchMock as unknown as typeof fetch });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('createProviderBundle for geelib', () => {
  it('assembles the geelib backlog provider and a refusing change channel', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('Matter/getMatterStatus')) {
        return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: [
          { id: 1, status_name: '新建', status_stage: '未开始' },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ errno: 2000, errmsg: '', data: { total: 1, matterList: [matter] } }), { status: 200 });
    });
    const repoRoot = mkdtempSync(join(tmpdir(), 'afk-geelib-bundle-'));

    const bundle = createProviderBundle(geelibTracker(), repoRoot);

    // The recorder wraps the geelib provider; the behavior is the contract.
    const item = await bundle.backlog.get('geelib:6856#1083121');
    expect(item).toMatchObject({ id: 'geelib:6856#1083121', state: 'ready' });
    // Change requests live on the git platform for geelib items (hybrid mode).
    await expect(bundle.changes.create({
      backlogId: 'geelib:6856#1083121', title: 't', sourceBranch: 'a', targetBranch: 'b',
    } as never)).rejects.toThrow(/git platform/i);
    rmSync(repoRoot, { recursive: true, force: true });
  });
});
