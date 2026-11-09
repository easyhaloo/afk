import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPluginRuntime, type DefaultPluginRuntimeOptions } from './default-runtime.js';
import { LifecycleDispatcher, type LifecycleContext } from '../workflows/lifecycle.js';
import type { PluginRuntime } from './runtime.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import { GitPushTriggerProvider, IssueEventTriggerProvider } from '../../infrastructure/providers/triggers.js';
import { startPluginListener } from './listener.js';
import { createPluginRunObserver } from './observability.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { createLocalEncryptedEvidenceStore } from '../../infrastructure/observability/local-evidence-store.js';
import type { RunEvent } from '@afk/core';

vi.mock('../workflows/execute-work-item.js', () => ({ executeWorkItem: vi.fn() }));

const directories: string[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

async function installedCredentialFixture(plugins: unknown[], requires = ['context.provider'], fail = false) {
  const { homeDir, workspaceRoot } = await fixture();
  const directory = join(homeDir, '.afk', 'plugins', 'credential.fixture', 'dist');
  await mkdir(directory, { recursive: true });
  const entry = join(directory, 'index.js');
  await writeFile(entry, `export let resolutions = 0;
    export default {
      manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], requires: ${JSON.stringify(requires)}, trusted: true },
      activate(context) {
        context.registerCredentialProvider('fixture', {
          id: 'fixture', capabilities: { read: true, rotate: false, 'scoped-token': false },
          async resolve() { resolutions++; ${fail ? "throw new Error('synthetic resolution failure');" : "return { secret: 'https://webhook.example.test/fixture' };"} }
        });
      }
    };`);
  await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'credential.fixture' }, ...plugins] }));
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
  runtimes.push(runtime);
  return { runtime, credential: await import(pathToFileURL(entry).href) };
}

describe('createDefaultPluginRuntime', () => {
  it('captures and exports evidence through the configured default runtime and keeps the key across restarts', async () => {
    const { runtime, homeDir, workspaceRoot } = await fixture({ integrations: { evidence: { provider: 'test-report-local', timeoutMs: 1000 } } });
    const root = join(workspaceRoot, 'audit');
    const context = { traceId: 'trace', runId: 'evidence-run', workItemId: 'github:acme/api#42', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
    await createPluginRunObserver(runtime, root).record(context, { kind: 'qa.passed' });
    const events: RunEvent[] = [];
    const store = new JsonlEventStore({ root });
    for await (const event of store.read(context.runId)) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[0].evidence).toHaveLength(1);
    expect(events[1].data).toMatchObject({ kind: 'effect.completed', effectKind: 'artifact.upload', outcome: 'succeeded' });
    const evidence = await createLocalEncryptedEvidenceStore(homeDir);
    expect(JSON.parse(Buffer.from(await evidence.get(events[0].evidence![0])).toString('utf8'))).toMatchObject({ kind: 'qa.passed' });
    expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
  });

  it('blocks configured audit capture when its artifact provider cannot write', async () => {
    const { runtime, lifecycle } = await fixture({ integrations: { evidence: { provider: 'missing-artifacts' } } });
    expect(await runtime.diagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'config.evidence-invalid' })]));
    await expect(lifecycle.run('init', { iid: 42, baseBranch: 'main', params: {}, originalCwd: '/' })).rejects.toThrow('Audit evidence');
  });

  it('propagates durable delivery identity to managed execution and deduplicates HTTP redelivery', async () => {
    vi.mocked(executeWorkItem).mockResolvedValue({ status: 'done' } as Awaited<ReturnType<typeof executeWorkItem>>);
    const { runtime, homeDir } = await fixture({ plugins: [
      { id: 'trigger.git-push', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'push', kind: 'webhook', input: { workItemId: 'github:acme/api#42' } }] } },
    ] }, { activateTriggers: true });
    const listener = await startPluginListener(runtime, { token: 'synthetic-listener-token', port: 0, queuePath: join(homeDir, '.afk', 'triggers', 'deliveries.sqlite') });
    try {
      const address = listener.address;
      if (!address || typeof address === 'string') throw new Error('Missing listener address');
      const send = () => fetch(`http://127.0.0.1:${address.port}/triggers/trigger.git-push`, { method: 'POST', headers: { authorization: 'Bearer synthetic-listener-token', 'x-github-delivery': 'stable-delivery' }, body: JSON.stringify({ ref: 'refs/heads/main' }) });
      const receipt = await (await send()).json() as { deliveryId: string };
      await vi.waitFor(() => expect(listener.queue!.status(receipt.deliveryId)[0].status).toBe('delivered'));
      expect(vi.mocked(executeWorkItem).mock.calls.at(-1)?.[0]).toMatchObject({ workItemId: 'github:acme/api#42', executionId: createHash('sha256').update(`${receipt.deliveryId}\0github:acme/api#42`).digest('hex') });
      const before = vi.mocked(executeWorkItem).mock.calls.length;
      expect((await send()).status).toBe(202);
      expect(vi.mocked(executeWorkItem).mock.calls).toHaveLength(before);
    } finally { await listener.close(); }
  });
  it.each([false, true])('waits for an installed named credential provider across builtin activation (nested: %s)', async nested => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const { runtime, credential } = await installedCredentialFixture([
      { id: 'notification.slack', builtin: true, config: { webhook: { provider: nested ? 'credential.enterprise' : 'fixture', name: 'webhook' } } },
      ...nested ? [{ id: 'credential.enterprise', builtin: true, config: { values: { webhook: { provider: 'fixture', name: 'webhook' } } } }] : [],
    ]);
    expect(runtime.getCredentialProvider('credential.system-keychain')).toBeDefined();
    expect(runtime.getCredentialProvider('fixture')).toBeDefined();
    expect(runtime.getNotificationProvider('notification.slack')).toBeDefined();
    expect(credential.resolutions).toBe(1);
    expect((await runtime.diagnostics()).filter(item => item.severity === 'error')).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports unresolved named credential dependencies without attempting activation (cycle: %s)', async cycle => {
    const { runtime, credential } = await installedCredentialFixture([
      { id: 'tracker.linear', builtin: true, config: { baseUrl: 'https://linear.example.test', teamId: 'team', token: { provider: cycle ? 'fixture' : 'missing', name: 'api' } } },
    ], cycle ? ['tracker.issue'] : ['context.provider']);
    expect(runtime.getCredentialProvider('credential.system-keychain')).toBeDefined();
    expect(runtime.getIssueTrackerProvider('linear')).toBeUndefined();
    expect(credential.resolutions).toBe(0);
    const errors = (await runtime.diagnostics()).filter(item => item.pluginId === 'tracker.linear');
    expect(errors.map(item => item.code)).toEqual(['load.dependencies']);
    if (cycle) expect(await runtime.diagnostics()).toContainEqual(expect.objectContaining({ pluginId: 'credential.fixture', code: 'load.dependencies' }));
  });

  it('does not retry a named provider resolution that actually fails', async () => {
    const { runtime, credential } = await installedCredentialFixture([
      { id: 'notification.slack', builtin: true, config: { webhook: { provider: 'fixture', name: 'webhook' } } },
    ], ['context.provider'], true);
    expect(runtime.getCredentialProvider('fixture')).toBeDefined();
    expect(runtime.getNotificationProvider('notification.slack')).toBeUndefined();
    expect(credential.resolutions).toBe(1);
    const errors = (await runtime.diagnostics()).filter(item => item.pluginId === 'notification.slack');
    expect(errors.map(item => item.code)).toEqual(['activation.failed', 'load.failed']);
    expect(errors.every(item => item.message.includes('credential resolution failed'))).toBe(true);
  });

  it('activates configured credential references before their consumers regardless of input order', async () => {
    vi.stubEnv('PLUGIN_E2E_WEBHOOK', 'https://webhook.example.test/fixture');
    const { runtime } = await fixture({ plugins: [
      { id: 'notification.slack', builtin: true, config: { webhook: { provider: 'credential.enterprise', name: 'webhook' } } },
      { id: 'credential.enterprise', builtin: true, config: { values: { webhook: { env: 'PLUGIN_E2E_WEBHOOK' } } } },
    ] });
    expect(runtime.getNotificationProvider('notification.slack')).toBeDefined();
    expect((await runtime.diagnostics()).filter(item => item.severity === 'error')).toEqual([]);
  });

  it('routes batched configured triggers using each originating plugin action', async () => {
    const { runtime } = await fixture({ plugins: [
      { id: 'trigger.git-push', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'push', kind: 'webhook', input: { workItemId: 'github:acme/api#42' } }] } },
      { id: 'trigger.issue-event', builtin: true, action: 'capability.invoke', config: { triggers: [{ id: 'issue', kind: 'webhook', input: { capability: 'policy.provider', provider: 'compliance-policy', operation: 'evaluate', input: { action: 'inspect' } } }] } },
    ] }, { activateTriggers: true });
    const dispatch = vi.spyOn(runtime, 'dispatchSystemAction').mockResolvedValue(undefined);
    await (runtime.getTriggerProvider('trigger.git-push') as GitPushTriggerProvider).handlePush({ ref: 'refs/heads/main' });
    await (runtime.getTriggerProvider('trigger.issue-event') as IssueEventTriggerProvider).handleIssue({ action: 'opened' });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual(['work-item.execute', 'capability.invoke']);
  });

  it('honors disabled builtin entries without requiring a configuration object', async () => {
    const { runtime } = await fixture({ plugins: [{ id: 'context.code', builtin: true, enabled: false }] });
    expect(runtime.getContextProvider('context.code')).toBeUndefined();
    expect(runtime.getContextProvider('context.retrieval')).toBeDefined();
  });

  it('lets an installed plugin replace a builtin with the same ID', async () => {
    const { homeDir, workspaceRoot } = await fixture({ plugins: [{ id: 'context.code', enabled: false }] });
    const directory = join(homeDir, '.afk', 'plugins', 'context.code', 'dist');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.js'), `export default {
      manifest: { id: 'context.code', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
      activate(context) { context.registerContextProvider('replacement', { id: 'replacement', capabilities: { 'read-only': true, summarize: false, search: false }, async gather() { return []; } }); }
    };`);
    await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'context.code', enabled: true }] }));
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(runtime);
    expect(runtime.getContextProvider('context.code')).toBeUndefined();
    expect(runtime.getContextProvider('replacement')).toBeDefined();
    expect((await runtime.diagnostics()).filter(item => item.severity === 'error')).toEqual([]);
  });

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
