import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  resolve: vi.fn(async () => ({ workItemId: 'github:acme/api#42' })),
}));
vi.mock('./execute-work-item.js', () => ({ executeWorkItem: mocks.execute }));
vi.mock('./run-request.js', () => ({ resolveWorkflowRunRequest: mocks.resolve }));
vi.mock('../../infrastructure/config/manager.js', () => ({ getWorkflowConfig: () => ({
  agentDefault: 'codex',
  agents: { codex: { transport: 'exec', auth: 'api', provider: 'configured', appServer: { startupTimeoutMs: 30000 } } },
}) }));
import { runWorkflowCli } from './run-cmd.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { TemplateLoader } from '../../domain/templates/loader.js';

describe('runWorkflowCli', () => {
  it('passes plugin composition as a dependency rather than serializable run options', async () => {
    const plugins = new PluginRuntime();
    mocks.execute.mockResolvedValue({ status: 'merge_ready' });
    await runWorkflowCli({ backlogId: '42', plugins });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ runOptions: { backlogId: '42' } }), {
      plugins, agentProviderRegistry: expect.anything(), template: expect.objectContaining({ name: 'issue-implementation' }),
    });
  });
  beforeEach(() => mocks.execute.mockReset());
  it('runs the managed implementation and QA chain with all explicit options', async () => {
    mocks.execute.mockResolvedValue({ status: 'merge_ready', changeUrl: 'https://example.test/42' });
    const options = { backlogId: '42', maxRetries: 4, hardTimeoutMs: 1000, executionMode: 'batch' as const,
      executionManifestPath: '/workspace/manifest.json', session: 'attempt-42' };
    await expect(runWorkflowCli(options)).resolves.toEqual({ success: true, url: 'https://example.test/42' });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'github:acme/api#42', manifestPath: options.executionManifestPath,
      executionId: 'attempt-42', runOptions: options,
    }), expect.objectContaining({ template: expect.objectContaining({ name: 'issue-implementation' }) }));
  });
  it('passes the classified execution snapshot through managed request resolution', async () => {
    const template = await new TemplateLoader().load('issue-implementation');
    const expected = structuredClone(template);
    const loading = vi.spyOn(TemplateLoader.prototype, 'load').mockResolvedValueOnce(template);
    mocks.resolve.mockImplementationOnce(async () => {
      loading.mockRejectedValue(new Error('template changed after classification'));
      return { workItemId: 'github:acme/api#42' };
    });
    mocks.execute.mockResolvedValue({ status: 'merge_ready' });
    try {
      await expect(runWorkflowCli({ backlogId: '42' })).resolves.toMatchObject({ success: true });
      expect(loading).toHaveBeenCalledOnce();
      expect(mocks.execute.mock.calls.at(-1)![1]).toMatchObject({ template: expected });
      expect(mocks.execute.mock.calls.at(-1)![0].runOptions).not.toHaveProperty('templateSnapshot');
    } finally { loading.mockRestore(); }
  });
  it.each(['blocked', 'rework', 'not_claimed'])('reports %s as unsuccessful', async status => {
    mocks.execute.mockResolvedValue({ status });
    expect((await runWorkflowCli({ backlogId: '42' })).success).toBe(false);
  });
  it('resolves explicit Codex overrides after routing and excludes raw overrides from execution options', async () => {
    mocks.execute.mockResolvedValue({ status: 'merge_ready' });
    await runWorkflowCli({ backlogId: '42', agentProvider: 'codex', agentRuntimeOverrides: {
      transport: 'app-server', auth: 'chatgpt', provider: 'openai', endpoint: 'ws://127.0.0.1:3210', authTokenEnv: 'CODEX_TOKEN',
    } });
    expect(mocks.execute.mock.calls.at(-1)![0].runOptions).toEqual({ backlogId: '42', agentProvider: 'codex', agentRuntime: {
      kind: 'codex', transport: 'app-server', auth: 'chatgpt', provider: 'openai', endpoint: 'ws://127.0.0.1:3210',
      authTokenEnv: 'CODEX_TOKEN', startupTimeoutMs: 30000,
    } });
  });
  it('uses the configured Agent and preserves configured runtime values alongside explicit overrides', async () => {
    mocks.execute.mockResolvedValue({ status: 'merge_ready' });
    await runWorkflowCli({ backlogId: '42', agentRuntimeOverrides: { profile: 'development' } });
    expect(mocks.execute.mock.calls.at(-1)![0].runOptions).toEqual({ backlogId: '42', agentRuntime: {
      kind: 'codex', transport: 'exec', auth: 'api', provider: 'configured', profile: 'development', startupTimeoutMs: 30000,
    } });
  });
  it('preserves the default runtime for other execution Agents when Codex overrides are supplied', async () => {
    mocks.execute.mockResolvedValue({ status: 'merge_ready' });
    await runWorkflowCli({ backlogId: '42', agentProvider: 'claude-code', agentRuntimeOverrides: { endpoint: 'invalid' } });
    expect(mocks.execute.mock.calls.at(-1)![0].runOptions).toEqual({
      backlogId: '42', agentProvider: 'claude-code', agentRuntime: { kind: 'default' },
    });
  });
});
