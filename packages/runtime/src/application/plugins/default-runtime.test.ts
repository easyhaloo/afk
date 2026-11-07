import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPluginRuntime, type DefaultPluginRuntimeOptions } from './default-runtime.js';
import { LifecycleDispatcher, type LifecycleContext } from '../workflows/lifecycle.js';
import type { PluginRuntime } from './runtime.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import { GitPushTriggerProvider } from '../../infrastructure/providers/triggers.js';

vi.mock('../workflows/execute-work-item.js', () => ({ executeWorkItem: vi.fn() }));

const directories: string[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(configuration?: unknown, options: DefaultPluginRuntimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'default-plugins-'));
  directories.push(root);
  const homeDir = join(root, 'home');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(join(homeDir, '.afk'), { recursive: true });
  await mkdir(workspaceRoot);
  if (configuration !== undefined) await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify(configuration));
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot, ...options });
  runtimes.push(runtime);
  const context: LifecycleContext = { iid: 42, worktreePath: workspaceRoot, baseBranch: 'main', sessionName: 'test-42', params: {} };
  return { runtime, context, homeDir, workspaceRoot, lifecycle: new LifecycleDispatcher(runtime.getLifecycleModules()) };
}

describe('createDefaultPluginRuntime', () => {
  it('maps a standard Git push event to configured managed work input', async () => {
    const input = { workItemId: 'github:acme/api#42', runOptions: { executionMode: 'batch' } };
    vi.mocked(executeWorkItem).mockResolvedValueOnce({ executionId: 'push-execution', workItemId: input.workItemId, status: 'merge_ready' });
    const { runtime } = await fixture({ plugins: [{ id: 'trigger.git-push', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'main-push', kind: 'webhook', payload: { branch: 'main' }, input }] } }] }, { activateTriggers: true });
    const trigger = runtime.getTriggerProvider('trigger.git-push') as GitPushTriggerProvider;
    await expect(trigger.handlePush({ ref: 'refs/heads/main' })).resolves.toEqual({ dispatched: 1 });
    expect(executeWorkItem).toHaveBeenCalledWith(input, { plugins: runtime, agentProviderRegistry: expect.anything() });
  });
  it('dispatches managed workflow execution through the same plugin composition', async () => {
    const { runtime } = await fixture();
    vi.mocked(executeWorkItem).mockResolvedValueOnce({ executionId: 'test-execution', workItemId: 'github:acme/api#42', status: 'merge_ready' });
    const input = { workItemId: 'github:acme/api#42', runOptions: { executionMode: 'batch' as const } };
    await expect(runtime.dispatchSystemAction('work-item.execute', input)).resolves.toMatchObject({ status: 'merge_ready' });
    expect(executeWorkItem).toHaveBeenCalledWith(input, { plugins: runtime, agentProviderRegistry: expect.anything() });
    vi.mocked(executeWorkItem).mockResolvedValueOnce({ executionId: 'failed-execution', workItemId: input.workItemId, status: 'blocked' });
    await expect(runtime.dispatchSystemAction('work-item.execute', { input })).rejects.toThrow('blocked');
  });
  it('loads shared providers and preserves false verification results as workflow failures', async () => {
    const { runtime, workspaceRoot } = await fixture();
    expect(runtime.listProviders('agent.provider')).toEqual(expect.arrayContaining(['claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot']));
    expect(runtime.listProviders('host.connection')).toEqual(expect.arrayContaining(['ssh', 'jumpserver', 'aws-ssm', 'kubernetes-exec']));
    await expect(runtime.dispatchSystemAction('capability.invoke', {
      worktreePath: workspaceRoot,
      input: { capability: 'verification.provider', provider: 'test-runner', operation: 'verify', input: { command: [process.execPath, '-e', 'process.exit(7)'] } },
    })).rejects.toThrow('required check');
  });

  it.each([
    { plugins: 'invalid' },
    { integrations: { policies: [{ provider: 'secret-scan' }] } },
    { plugins: [{ id: 'notification.slack', builtin: true, config: {} }] },
  ])('reports invalid settings and blocks workflow initialization', async configuration => {
    const { runtime, lifecycle } = await fixture(configuration);
    expect((await runtime.diagnostics()).some(diagnostic => diagnostic.severity === 'error')).toBe(true);
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: '/' })).rejects.toThrow();
  });

  it('writes selected context into the execution worktree and removes it on cleanup', async () => {
    const { workspaceRoot, context, lifecycle } = await fixture({ integrations: { contexts: [{ provider: 'context.code', query: { scope: '.', prompt: 'widget' } }] } });
    await writeFile(join(workspaceRoot, 'widget.ts'), 'export const widget = 42;');
    await lifecycle.run('before-agent', context);
    expect(await readFile(join(workspaceRoot, '.afk', 'plugin-context.md'), 'utf8')).toContain('widget = 42');
    await lifecycle.run('cleanup', context);
    await expect(readFile(join(workspaceRoot, '.afk', 'plugin-context.md'))).rejects.toThrow();
  });
  it('blocks publishing generated secrets from the actual worktree rather than scanning the source checkout', async () => {
    const { lifecycle, context, homeDir } = await fixture({ integrations: { policies: [{ provider: 'secret-scan', input: { action: 'publish' } }] } });
    const worktreePath = join(homeDir, 'execution');
    await mkdir(worktreePath);
    await lifecycle.run('before-agent', { ...context, worktreePath });
    await writeFile(join(worktreePath, 'generated.env'), 'password=synthetic-sensitive-value');
    await expect(lifecycle.run('before-publish', { ...context, worktreePath })).rejects.toThrow('Execution denied by capability policy');
  });
  it('never includes malformed YAML source text in diagnostics', async () => {
    const { homeDir, workspaceRoot } = await fixture();
    await writeFile(join(homeDir, '.afk', 'plugins.yml'), 'token: SYNTHETIC_SECRET_VALUE: invalid');
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(runtime);
    expect(JSON.stringify(await runtime.diagnostics())).not.toContain('SYNTHETIC_SECRET_VALUE');
    expect(runtime.getPlugin('workflow.invalid-settings')).toBeDefined();
  });

  it('rejects context output through an execution worktree symlink', async () => {
    const { workspaceRoot, context, lifecycle, homeDir } = await fixture({ integrations: { contexts: [{ provider: 'context.code', query: { scope: 'widget.ts', prompt: 'widget' } }] } });
    await writeFile(join(workspaceRoot, 'widget.ts'), 'widget');
    await symlink(homeDir, join(workspaceRoot, '.afk'));
    await expect(lifecycle.run('before-agent', context)).rejects.toThrow('symbolic link');
    await expect(readFile(join(homeDir, 'plugin-context.md'))).rejects.toThrow();
  });

  it('configures trigger providers without starting timers in ordinary execution', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    try {
      const { runtime } = await fixture({ plugins: [{ id: 'trigger.schedule', builtin: true, config: { triggers: [{ id: 'interval', kind: 'schedule', schedule: '1000' }] } }] });
      expect(timer).not.toHaveBeenCalled();
      expect(runtime.getPlugin('workflow.invalid-settings')).toBeUndefined();
    } finally { timer.mockRestore(); }
  });
  it('activates schedules only for the listener and dispatches nested operation input', async () => {
    vi.useFakeTimers();
    try {
      const payload = { capability: 'context.provider', provider: 'context.code', operation: 'gather', input: { scope: '.', prompt: 'widget' } };
      const { runtime } = await fixture({ plugins: [{ id: 'trigger.schedule', builtin: true, action: 'capability.invoke', config: { triggers: [{ id: 'interval', kind: 'schedule', schedule: '1000', payload }] } }] }, { activateTriggers: true });
      const capture = vi.spyOn(runtime.getContextProvider('context.code')!, 'gather').mockResolvedValue([]);
      expect(runtime.getPlugin('workflow.invalid-settings')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(capture).toHaveBeenCalledWith(payload.input);
      await runtime.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('disarms schedules whose action is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = await fixture({ plugins: [{ id: 'trigger.schedule', builtin: true, action: 'missing.action', config: { triggers: [{ id: 'interval', kind: 'schedule', schedule: '1000' }] } }] }, { activateTriggers: true });
      expect(runtime.getTriggerProvider('trigger.schedule')).toBeUndefined();
      expect((await runtime.diagnostics()).some(result => result.code === 'trigger.action-missing')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
