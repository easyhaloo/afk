import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  resolve: vi.fn(async () => ({ workItemId: 'github:acme/api#42' })),
}));
vi.mock('./execute-work-item.js', () => ({ executeWorkItem: mocks.execute }));
vi.mock('./run-request.js', () => ({ resolveWorkflowRunRequest: mocks.resolve }));
vi.mock('../../infrastructure/config/manager.js', () => ({ getWorkflowConfig: () => ({}) }));
import { runWorkflowCli } from './run-cmd.js';

describe('runWorkflowCli', () => {
  beforeEach(() => mocks.execute.mockReset());
  it('runs the managed implementation and QA chain with all explicit options', async () => {
    mocks.execute.mockResolvedValue({ status: 'merge_ready', changeUrl: 'https://example.test/42' });
    const options = { backlogId: '42', maxRetries: 4, hardTimeoutMs: 1000, executionMode: 'batch' as const,
      executionManifestPath: '/workspace/manifest.json', session: 'attempt-42' };
    await expect(runWorkflowCli(options)).resolves.toEqual({ success: true, url: 'https://example.test/42' });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'github:acme/api#42', manifestPath: options.executionManifestPath,
      executionId: 'attempt-42', runOptions: options,
    }));
  });
  it.each(['blocked', 'rework', 'not_claimed'])('reports %s as unsuccessful', async status => {
    mocks.execute.mockResolvedValue({ status });
    expect((await runWorkflowCli({ backlogId: '42' })).success).toBe(false);
  });
});
