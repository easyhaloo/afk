import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createBacklogRuntime } from '@afk/runtime/backlog';
import type { QABacklogProvider } from '@afk/runtime/domain/backlog/index';
import { createRuntimeBacklogService } from '../../apps/desktop/electron/services/runtime-backlog-service.js';
import { runBacklogList } from '../../apps/cli/src/commands/backlog.js';

describe('CLI and Desktop shared backlog runtime', () => {
  it('projects the same provider results through CLI JSON and Desktop DTOs', async () => {
    const item = { id: '42', title: 'shared task', description: 'demo', state: 'ready' as const, executionMode: 'afk' as const, dependsOn: [], tags: [], branchName: 'afk/42', providerRef: 'github:acme/api#42' };
    const list = vi.fn(async () => [item]);
    const provider = { list } as unknown as QABacklogProvider;
    const runtime = createBacklogRuntime(async () => ({ backlog: provider, changes: {} as never }));
    const desktop = createRuntimeBacklogService(value => value, runtime);
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    try { await runBacklogList(provider, { state: 'ready', json: true }); }
    finally { write.mockRestore(); }
    const envelope = JSON.parse(output.join(''));
    expect(envelope).toMatchObject({ ok: true, kind: 'backlog.list' });
    expect(await desktop.list('/workspace', { state: 'ready' })).toEqual(envelope.data);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('emits one CLI JSON failure for missing required options', () => {
    const result = spawnSync(process.execPath, ['apps/cli/dist/index.js', 'backlog', 'show', '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, kind: 'backlog.show', error: { code: 'validation' } });
    expect(result.stderr).not.toContain('CommanderError');
  });
});
