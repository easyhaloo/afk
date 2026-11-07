import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredPlugins, type ConfiguredPluginsOptions } from './configured.js';
import { PluginRuntime } from './runtime.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';
import { WebhookTriggerProvider, ScheduleTriggerProvider, GitPushTriggerProvider, IssueEventTriggerProvider, TestReportProvider, ObjectStorageProvider } from '../../infrastructure/providers/index.js';
import type { CommandRequest } from '../../infrastructure/providers/dependencies.js';
import { GitHubClient } from '../../infrastructure/github/client.js';
import { GitLabClient } from '../../infrastructure/gitlab/index.js';
import { SandboxProviderRegistry } from '../../infrastructure/sandbox/registry.js';
import { LocalSandboxProvider, ContainerSandboxProvider } from '../../infrastructure/sandbox/providers/index.js';
import { WorktreeManager } from '../../infrastructure/git/worktree.js';
import type { RemoteContainerCliTransportOptions } from '../../infrastructure/sandbox/remote-container.js';

const environment = { TOKEN: 'fixture-token', HOOK: 'https://hooks.example.test/private-hook' };
const subscription = { id: 'subscription', kind: 'webhook' };
const secretRef = { env: 'TOKEN' };
type Configuration = ConfiguredPluginsOptions['configurations'][number];
const configurations: readonly Configuration[] = [
  { id: 'agent.claude-code' }, { id: 'agent.codex' }, { id: 'agent.cursor' }, { id: 'agent.pi' }, { id: 'agent.opencode' }, { id: 'agent.copilot' },
  { id: 'host.ssh', config: { hosts: [{ alias: 'build', address: '10.0.0.1', identityFile: '~/test-keys/id' }] } },
  { id: 'host.aws-ssm', config: { hosts: [{ alias: 'build', instanceId: 'i-123' }], region: 'us-east-1' } },
  { id: 'host.kubernetes-exec', config: { hosts: [{ alias: 'build', pod: 'build-pod' }], namespace: 'builds' } },
  { id: 'host.jumpserver', config: {} },
  { id: 'sandbox.local', config: {} },
  { id: 'sandbox.docker', config: { engine: 'docker' } },
  { id: 'sandbox.podman', config: { engine: 'podman' } },
  { id: 'sandbox.remote-container', config: { transport: 'http', endpoint: 'https://containers.example.test/api', token: secretRef } },
  { id: 'tracker.github', config: { repo: 'owner/repository', token: secretRef } },
  { id: 'tracker.gitlab', config: { url: 'https://gitlab.example.test', projectId: 'group/project', token: secretRef } },
  { id: 'tracker.linear', config: { baseUrl: 'https://linear.example.test', teamId: 'team', token: secretRef } },
  { id: 'tracker.jira', config: { baseUrl: 'https://jira.example.test', projectKey: 'PROJ', token: secretRef } },
  { id: 'notification.feishu', config: { webhook: { env: 'HOOK' } } },
  { id: 'notification.slack', config: { webhook: { env: 'HOOK' } } },
  { id: 'notification.email', config: { from: 'build@example.test', to: 'dev@example.test' } },
  { id: 'notification.desktop', config: {} },
  { id: 'trigger.webhook', config: { secret: secretRef, triggers: [subscription] } },
  { id: 'trigger.schedule', config: { triggers: [{ id: 'interval', kind: 'schedule', schedule: '1000' }] } },
  { id: 'trigger.git-push', config: { triggers: [subscription] } },
  { id: 'trigger.issue-event', config: { triggers: [subscription] } },
  { id: 'context.code', config: { root: '.' } },
  { id: 'context.knowledge-base', config: { endpoint: 'https://knowledge.example.test/query' } },
  { id: 'context.retrieval', config: { documents: [{ origin: 'guide', content: 'build instructions' }] } },
  { id: 'context.project-memory', config: { file: 'memory.json' } },
  { id: 'credential.system-keychain', config: { service: 'development' } },
  { id: 'credential.oauth', config: { tokenEndpoint: 'https://auth.example.test/token', clientId: 'client', clientSecret: secretRef } },
  { id: 'credential.oidc', config: { issuer: 'https://auth.example.test', clientId: 'client', assertion: secretRef } },
  { id: 'credential.enterprise', config: { values: { deployment: secretRef } } },
  { id: 'artifact.test-report-local', config: { root: 'reports' } },
  { id: 'artifact.evidence-bundle', config: { root: 'evidence' } },
  { id: 'artifact.object-storage', config: { endpoint: 'https://storage.example.test/bucket' } },
  { id: 'artifact.report-platform', config: { endpoint: 'https://reports.example.test/upload', token: secretRef } },
  { id: 'repository.multi-repository', config: { repositories: [{ name: 'project', path: '.' }] } },
  { id: 'repository.remote-workspace', config: { baseUrl: 'https://workspaces.example.test', token: secretRef } },
  { id: 'repository.special-git-backend', config: { backend: 'special-git' } },
  { id: 'policy.secret-scan', config: { root: '.' } },
  { id: 'policy.license-policy', config: { allowlist: ['MIT'], licenses: ['MIT'] } },
  { id: 'policy.compliance-policy', config: { rules: [{ id: 'deploy', effect: 'allow', actions: ['deploy'], when: { approved: true } }] } },
  { id: 'verification.test-runner', config: { command: ['npm', 'test'] } },
  { id: 'verification.static-scan', config: { command: ['npm', 'run', 'lint'] } },
  { id: 'verification.browser-check', config: { command: ['playwright', 'test'] } },
];

const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function load(selected: readonly Configuration[], options: Partial<ConfiguredPluginsOptions> = {}) {
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  const plugins = await createConfiguredPlugins({ configurations: selected, environment, onTrigger: () => undefined, ...options });
  for (const plugin of plugins) await runtime.activate(plugin);
  return { runtime, plugins };
}

function config(id: string): Configuration { return configurations.find(item => item.id === id)!; }

describe('configured plugin composition', () => {
  it.each(configurations)('constructs and registers $id with its declared capability', async configuration => {
    vi.useFakeTimers();
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    const execute = vi.fn(async (_request: CommandRequest) => ({ stdout: '', stderr: '' }));
    const [plugin] = await createConfiguredPlugins({ configurations: [configuration], environment, fetch: network, execute, onTrigger: () => undefined });
    expect(plugin.manifest.id).toBe(configuration.id);
    expect(plugin.manifest.id.split('.')).toHaveLength(2);
    expect(plugin.manifest.trusted).toBe(true);
    expect(plugin.manifest.provides).toHaveLength(['tracker.github', 'tracker.gitlab'].includes(configuration.id) ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
    const runtime = new PluginRuntime();
    runtimes.push(runtime);
    await runtime.activate(plugin);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.listProvidersForPlugin(configuration.id)).toHaveLength(plugin.manifest.provides.length);
    expect(runtime.listProviders(plugin.manifest.provides[0])).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('covers all twelve domains together and cleans up timers on close', async () => {
    vi.useFakeTimers();
    const { runtime, plugins } = await load(configurations, { activateTriggers: true });
    expect(new Set(plugins.map(plugin => plugin.manifest.id.split('.')[0])).size).toBe(12);
    expect(runtime.listPlugins()).toHaveLength(configurations.length);
    expect(vi.getTimerCount()).toBe(1);
    await runtime.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('registers concrete GitHub and GitLab tracker and backlog providers under their platform names', async () => {
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal('fetch', network);
    const { runtime, plugins } = await load([config('tracker.github'), config('tracker.gitlab')]);
    expect(runtime.getTrackerProvider('github')).toBeInstanceOf(GitHubClient);
    expect(runtime.getTrackerProvider('github')!.projectId).toBe('owner/repository');
    expect(runtime.getTrackerProvider('gitlab')).toBeInstanceOf(GitLabClient);
    expect(runtime.getTrackerProvider('gitlab')!.projectId).toBe('group/project');
    expect(runtime.listBacklogProviders()).toEqual(['github', 'gitlab']);
    for (const plugin of plugins) expect(plugin.manifest.provides).toEqual(['tracker.provider', 'backlog.provider']);
    expect(network).not.toHaveBeenCalled();
    await runtime.close();
    expect(runtime.getTrackerProvider('github')).toBeUndefined();
    expect(runtime.getBacklogProvider('gitlab')).toBeUndefined();
  });

  it.each(['client_secret_basic', 'client_secret_post'])('passes OAuth %s authentication and scope to the concrete provider', async authMethod => {
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(Response.json({ access_token: 'access-token', token_type: 'Bearer', scope: 'read' }));
    const { runtime } = await load([{ id: 'credential.oauth', config: { ...config('credential.oauth').config, authMethod, timeoutMs: 1000 } }], { fetch: network });
    expect(network).not.toHaveBeenCalled();
    await expect(runtime.getCredentialProvider('credential.oauth')!.resolve({ name: 'api', scope: 'read' })).resolves.toEqual({ secret: 'access-token' });
    const request = network.mock.calls[0][1]!;
    const body = new URLSearchParams(String(request.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe('read');
    if (authMethod === 'client_secret_post') expect(body.get('client_secret')).toBe(environment.TOKEN);
    else expect(new Headers(request.headers).get('authorization')).toBe(`Basic ${Buffer.from(`client:${environment.TOKEN}`).toString('base64')}`);
  });

  it('uses OIDC discovery before the pinned endpoint and resolves exchange token references', async () => {
    const issuer = 'https://auth.example.test/tenant';
    const tokenEndpoint = 'https://tokens.example.test/exchange';
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce(Response.json({ issuer, token_endpoint: tokenEndpoint }))
      .mockResolvedValueOnce(Response.json({ access_token: 'access-token', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }));
    const { runtime } = await load([{ id: 'credential.oidc', config: {
      issuer, clientId: 'client', assertion: secretRef, tokenEndpoint, timeoutMs: 1000,
      exchange: { subjectToken: { env: 'SUBJECT' }, subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt', audience: 'api', resource: 'https://api.example.test' },
    } }], { fetch: network, environment: { ...environment, SUBJECT: 'subject-token' } });
    expect(network).not.toHaveBeenCalled();
    await expect(runtime.getCredentialProvider('credential.oidc')!.resolve({ name: 'api' })).resolves.toEqual({ secret: 'access-token' });
    expect(String(network.mock.calls[0][0])).toBe(`${issuer}/.well-known/openid-configuration`);
    expect(String(network.mock.calls[1][0])).toBe(tokenEndpoint);
    const body = new URLSearchParams(String(network.mock.calls[1][1]!.body));
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('client_assertion')).toBe(environment.TOKEN);
    expect(body.get('subject_token')).toBe('subject-token');
    expect(body.get('audience')).toBe('api');
    expect(body.get('resource')).toBe('https://api.example.test');
  });

  it('rejects OIDC discovery metadata inconsistent with issuer or endpoint pin before exchanging secrets', async () => {
    for (const metadata of [
      { issuer: 'https://other.example.test', token_endpoint: 'https://auth.example.test/token' },
      { issuer: 'https://auth.example.test', token_endpoint: 'https://other.example.test/token' },
    ]) {
      const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(Response.json(metadata));
      const { runtime } = await load([{ id: 'credential.oidc', config: { ...config('credential.oidc').config, tokenEndpoint: 'https://auth.example.test/token' } }], { fetch: network });
      await expect(runtime.getCredentialProvider('credential.oidc')!.resolve({ name: 'api' })).rejects.toThrow(/mismatch|pin/);
      expect(network).toHaveBeenCalledTimes(1);
      expect(network.mock.calls[0][1]!.body).toBeUndefined();
    }
  });

  it.each(configurations.filter(item => !item.id.startsWith('agent.') && !['host.jumpserver', 'sandbox.local', 'sandbox.docker', 'sandbox.podman', 'notification.desktop'].includes(item.id)))('rejects missing configuration for $id', async ({ id }) => {
    await expect(createConfiguredPlugins({ configurations: [{ id }], environment })).rejects.toThrow(`plugin '${id}'`);
    await expect(createConfiguredPlugins({ configurations: [{ id, config: {} }], environment })).rejects.toThrow('invalid configuration fields');
  });

  it.each([
    ['host.ssh', { hosts: [{ alias: 'test', address: 'host', port: 0 }] }],
    ['host.aws-ssm', { hosts: [] }],
    ['host.kubernetes-exec', { hosts: [{ alias: 'test' }] }],
    ['sandbox.remote-container', { transport: 'cli' }],
    ['sandbox.remote-container', { transport: 'http', endpoint: 'file:///tmp/service' }],
    ['sandbox.docker', { engine: 'podman' }],
    ['sandbox.podman', { engine: 'docker' }],
    ['sandbox.local', { engine: 'docker' }],
    ['host.jumpserver', { serverAlias: '' }],
    ['notification.desktop', { platform: 'unsupported' }],
    ['tracker.linear', { teamId: 'test', baseUrl: 'https://example.test', token: 'plaintext-token' }],
    ['tracker.github', { repo: 'invalid', token: secretRef }],
    ['tracker.gitlab', { url: 'https://gitlab.example.test', projectId: 0, token: secretRef }],
    ['notification.slack', { webhook: { env: 'HOOK', extra: true } }],
    ['notification.email', { from: 'invalid-address', to: 'dev@example.test' }],
    ['trigger.schedule', { triggers: [{ id: 'bad', kind: 'schedule', schedule: '0' }] }],
    ['trigger.git-push', { triggers: [{ id: 'bad', kind: 'manual' }] }],
    ['context.retrieval', { documents: [] }],
    ['credential.oidc', { issuer: 'http://example.test', clientId: 'client', assertion: secretRef }],
    ['credential.oauth', { tokenEndpoint: 'https://auth.example.test/token', clientId: 'client', clientSecret: secretRef, state: 'obsolete' }],
    ['credential.oauth', { tokenEndpoint: 'http://auth.example.test/token', clientId: 'client', clientSecret: secretRef }],
    ['credential.oauth', { tokenEndpoint: 'https://auth.example.test/token', clientId: 'client', clientSecret: secretRef, authMethod: 'none' }],
    ['credential.oidc', { issuer: 'https://auth.example.test', clientId: 'client', assertion: secretRef, exchange: { subjectToken: 'plaintext', subjectTokenType: 'jwt' } }],
    ['credential.enterprise', { values: {} }],
    ['artifact.object-storage', { endpoint: 'https://user:password@example.test' }],
    ['repository.multi-repository', { repositories: [{ name: 'same', path: 'a' }, { name: 'same', path: 'b' }] }],
    ['policy.compliance-policy', { rules: [] }],
    ['policy.license-policy', { allowlist: [] }],
    ['verification.browser-check', { command: [] }],
    ['verification.test-runner', { command: ['npm'], timeoutMs: -1 }],
  ] satisfies [string, { [key: string]: PluginConfigValue }][])('rejects invalid %s configuration', async (id, value) => {
    await expect(createConfiguredPlugins({ configurations: [{ id, config: value }], environment })).rejects.toThrow('invalid configuration fields');
  });

  it('rejects unknown plugins, inherited names, duplicates and unexpected keys', async () => {
    for (const id of ['made.up', 'toString', '__proto__']) await expect(createConfiguredPlugins({ configurations: [{ id }] })).rejects.toThrow('unknown configured plugin');
    await expect(createConfiguredPlugins({ configurations: [config('notification.slack'), config('notification.slack')], environment })).rejects.toThrow('duplicate configured plugin');
    await expect(createConfiguredPlugins({ configurations: [{ id: 'artifact.object-storage', config: { endpoint: 'https://example.test', ignored: true } }] })).rejects.toThrow('invalid configuration fields');
  });

  it('only accepts object environment references and never echoes secret values', async () => {
    const invalidTokens: PluginConfigValue[] = ['literal-super-secret', 'env:TOKEN', { env: 'MISSING' }, { env: 'TOKEN', literal: 'hidden' }];
    for (const token of invalidTokens) {
      const promise = createConfiguredPlugins({ configurations: [{ id: 'tracker.linear', config: { baseUrl: 'https://example.test', teamId: 'team', token } }], environment });
      await expect(promise).rejects.toThrow('token');
      await expect(promise).rejects.not.toThrow('literal-super-secret');
      await expect(promise).rejects.not.toThrow(environment.TOKEN);
    }
  });

  it('uses global fetch lazily, resolves secret references and preserves provider registration names', async () => {
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(new Response('ok'));
    const { runtime } = await load([config('notification.slack'), config('context.retrieval')]);
    vi.stubGlobal('fetch', network);
    expect(network).not.toHaveBeenCalled();
    await expect(runtime.getNotificationProvider('notification.slack')!.notify({ title: 'Build', body: 'Passed' })).resolves.toMatchObject({ delivered: true });
    expect(String(network.mock.calls[0]?.[0])).toBe(environment.HOOK);
    expect(runtime.listProviders('context.provider')).toEqual(['context.retrieval']);
  });

  it('adapts provider health and doctor without probing during construction or activation', async () => {
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockImplementation(async () => new Response(JSON.stringify({ data: { viewer: { id: 'user' } } })));
    const { runtime, plugins } = await load([config('tracker.linear'), config('host.ssh')], { fetch: network });
    expect(network).not.toHaveBeenCalled();
    await expect(runtime.health('tracker.linear')).resolves.toMatchObject([{ status: 'healthy' }]);
    await expect(runtime.diagnostics('tracker.linear')).resolves.toEqual([]);
    expect(network).toHaveBeenCalledTimes(2);
    await expect(plugins[1].health!()).resolves.toMatchObject({ status: 'unknown' });
    const provider = runtime.getIssueTrackerProvider('linear')!;
    vi.spyOn(provider, 'health').mockResolvedValue({ status: 'unavailable', message: `bad ${environment.TOKEN}` });
    vi.spyOn(provider, 'doctor').mockResolvedValue([{ check: 'auth', ok: false, detail: environment.TOKEN }]);
    await expect(plugins[0].health!()).resolves.toMatchObject({ status: 'unhealthy', message: 'bad [redacted]' });
    await expect(plugins[0].diagnostics!()).resolves.toMatchObject([{ severity: 'warning', message: '[redacted]' }]);
    vi.spyOn(provider, 'health').mockRejectedValue(new Error(environment.TOKEN));
    await expect(plugins[0].health!()).resolves.toMatchObject({ status: 'unhealthy', message: 'Provider health check failed' });
  });

  it('requires trigger callbacks and unique subscription ids', async () => {
    for (const configuration of configurations.filter(item => item.id.startsWith('trigger.'))) {
      for (const activateTriggers of [undefined, false, true]) {
        await expect(createConfiguredPlugins({ configurations: [configuration], environment, activateTriggers })).rejects.toThrow('onTrigger callback is required');
      }
    }
    await expect(createConfiguredPlugins({ configurations: [{ id: 'trigger.git-push', config: { triggers: [subscription, subscription] } }], onTrigger: () => undefined })).rejects.toThrow('trigger ids must be unique');
  });

  it.each([undefined, false])('keeps trigger providers discoverable without subscriptions or timers when activateTriggers is %s', async activateTriggers => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const registrations = [WebhookTriggerProvider, ScheduleTriggerProvider, GitPushTriggerProvider, IssueEventTriggerProvider].map(provider => vi.spyOn(provider.prototype, 'register'));
    const selected = configurations.filter(item => item.id.startsWith('trigger.'));
    const { runtime } = await load(selected, { activateTriggers, onTrigger });
    expect(runtime.listProviders('trigger.provider')).toEqual(selected.map(item => item.id));
    await expect(runtime.health()).resolves.toHaveLength(4);
    await expect(runtime.diagnostics()).resolves.toEqual([]);
    expect((runtime.getTriggerProvider('trigger.schedule') as ScheduleTriggerProvider).armedTimerIds).toEqual([]);
    const body = JSON.stringify({ event: 'build', payload: {} });
    const signature = createHmac('sha256', environment.TOKEN).update(body).digest('hex');
    await expect((runtime.getTriggerProvider('trigger.webhook') as WebhookTriggerProvider).handle(body, signature)).resolves.toEqual({ dispatched: 0 });
    await expect((runtime.getTriggerProvider('trigger.git-push') as GitPushTriggerProvider).handlePush({ ref: 'refs/heads/main' })).resolves.toEqual({ dispatched: 0 });
    await expect((runtime.getTriggerProvider('trigger.issue-event') as IssueEventTriggerProvider).handleIssue({ action: 'opened' })).resolves.toEqual({ dispatched: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
    expect(onTrigger).not.toHaveBeenCalled();
    for (const register of registrations) expect(register).not.toHaveBeenCalled();
    await runtime.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts schedules only in the explicitly enabled listener runtime', async () => {
    vi.useFakeTimers();
    const passiveCallback = vi.fn();
    const listenerCallback = vi.fn();
    const passive = await load([config('trigger.schedule')], { onTrigger: passiveCallback });
    const listener = await load([config('trigger.schedule')], { activateTriggers: true, onTrigger: listenerCallback });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(passiveCallback).not.toHaveBeenCalled();
    expect(listenerCallback).toHaveBeenCalledTimes(1);
    await passive.runtime.close();
    expect(vi.getTimerCount()).toBe(1);
    await listener.runtime.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('routes webhook, push, issue and schedule events and disposes subscriptions exactly once', async () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const { runtime } = await load(configurations.filter(item => item.id.startsWith('trigger.')), { onTrigger, activateTriggers: true });
    const schedule = runtime.getTriggerProvider('trigger.schedule') as ScheduleTriggerProvider;
    const dispose = vi.spyOn(schedule, 'dispose');
    expect(schedule.armedTimerIds).toEqual(['interval']);
    const webhook = runtime.getTriggerProvider('trigger.webhook') as WebhookTriggerProvider;
    const body = JSON.stringify({ event: 'build', payload: { success: true } });
    const signature = createHmac('sha256', environment.TOKEN).update(body).digest('hex');
    await webhook.handle(body, signature);
    await (runtime.getTriggerProvider('trigger.git-push') as GitPushTriggerProvider).handlePush({ ref: 'refs/heads/main' });
    await (runtime.getTriggerProvider('trigger.issue-event') as IssueEventTriggerProvider).handleIssue({ action: 'opened' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTrigger.mock.calls.map(([event]) => event.pluginId)).toEqual(['trigger.webhook', 'trigger.git-push', 'trigger.issue-event', 'trigger.schedule']);
    await runtime.close();
    expect(dispose).toHaveBeenCalledOnce();
    expect(schedule.armedTimerIds).toEqual([]);
    await expect(webhook.handle(body, signature)).resolves.toEqual({ dispatched: 0 });
  });

  it('runs remote-container CLI and HTTP operations only when invoked', async () => {
    const remoteRun = vi.fn<Parameters<NonNullable<RemoteContainerCliTransportOptions['run']>>, ReturnType<NonNullable<RemoteContainerCliTransportOptions['run']>>>()
      .mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ iid: 1, path: '/remote/work', branch: 'work/1' }), stderr: '' });
    const cli = await load([{ id: 'sandbox.remote-container', config: { transport: 'cli', command: 'remote-cli', timeoutMs: 2345 } }], { remoteRun });
    expect(remoteRun).not.toHaveBeenCalled();
    await cli.runtime.getSandboxProvider('remote-container')!.createWorktree({ iid: 1, baseBranch: 'main' });
    expect(remoteRun).toHaveBeenCalledWith(['remote-cli', 'workspace.create', JSON.stringify({ iid: 1, baseBranch: 'main' })], { timeoutMs: 2345, signal: undefined });
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(Response.json({ iid: 2, path: '/remote/two', branch: 'work/2' }));
    const http = await load([config('sandbox.remote-container')], { fetch: network });
    expect(network).not.toHaveBeenCalled();
    await http.runtime.getSandboxProvider('remote-container')!.createWorktree({ iid: 2, baseBranch: 'main' });
    expect(String(network.mock.calls[0]?.[0])).toBe('https://containers.example.test/api/workspace.create');
    expect(network.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${environment.TOKEN}`, 'Content-Type': 'application/json' }, redirect: 'error' });
    expect(JSON.parse(String(network.mock.calls[0][1]!.body))).toEqual({ iid: 2, baseBranch: 'main' });
  });

  it('preserves failed CLI exit codes and validates remote HTTP response content', async () => {
    const remoteRun = vi.fn(async () => ({ exitCode: 17, stdout: '', stderr: 'remote failed' }));
    const { runtime: cli } = await load([{ id: 'sandbox.remote-container', config: { transport: 'cli', command: 'remote-cli' } }], { remoteRun });
    await expect(cli.getSandboxProvider('remote-container')!.createWorktree({ iid: 1, baseBranch: 'main' })).rejects.toThrow('remote failed');
    const execute = vi.fn(async () => ({ stdout: '{}', stderr: '' }));
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'text/plain' } }));
    const { runtime: http } = await load([config('sandbox.remote-container')], { fetch: network, execute });
    await expect(http.getSandboxProvider('remote-container')!.createWorktree({ iid: 1, baseBranch: 'main' })).rejects.toThrow('non-JSON content type');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['host.jumpserver', 'notification.desktop', 'sandbox.local', 'sandbox.docker', 'sandbox.podman'])('accepts absent and empty configuration for %s', async id => {
    for (const entry of [{ id }, { id, config: {} }]) {
      const [plugin] = await createConfiguredPlugins({ configurations: [entry] });
      expect(plugin.manifest.id).toBe(id);
      const runtime = new PluginRuntime();
      runtimes.push(runtime);
      await runtime.activate(plugin);
      expect(runtime.listProvidersForPlugin(id)).toHaveLength(1);
    }
  });

  it('uses existing sandbox factories and delegates local worktrees to injected dependencies', async () => {
    const worktreeManager = new WorktreeManager();
    const create = vi.spyOn(worktreeManager, 'create').mockResolvedValue({ iid: 3, path: '/virtual/work', branch: 'work/3', createdAt: new Date(), status: 'active' });
    const { runtime } = await load([config('sandbox.local'), config('sandbox.docker'), config('sandbox.podman')], { sandboxDeps: { worktreeManager } });
    expect(runtime.getSandboxProvider('local')).toBeInstanceOf(LocalSandboxProvider);
    expect(runtime.getSandboxProvider('docker')).toBeInstanceOf(ContainerSandboxProvider);
    expect(runtime.getSandboxProvider('podman')).toBeInstanceOf(ContainerSandboxProvider);
    expect(runtime.getSandboxProvider('docker')!.name).toBe('docker');
    expect(runtime.getSandboxProvider('podman')!.name).toBe('podman');
    expect(create).not.toHaveBeenCalled();
    await expect(runtime.getSandboxProvider('local')!.createWorktree({ iid: 3, baseBranch: 'main' })).resolves.toMatchObject({ path: '/virtual/work' });
    expect(create).toHaveBeenCalledWith(3, 'main', undefined);
  });

  it('delivers configured desktop notifications through the existing executor', async () => {
    const execute = vi.fn(async (_request: CommandRequest) => ({ stdout: '', stderr: '' }));
    const { runtime } = await load([{ id: 'notification.desktop', config: { platform: 'linux', channel: 'builds' } }], { execute });
    expect(execute).not.toHaveBeenCalled();
    await expect(runtime.getNotificationProvider('notification.desktop')!.notify({ title: 'Build', body: 'Passed' })).resolves.toMatchObject({ delivered: true, channel: 'builds' });
    expect(execute.mock.calls[0][0].command).toBe('notify-send');
    expect(execute.mock.calls[0][0].args).toContain('Passed');
  });

  it('adapts direct provider health, diagnostics and disposal without duplicate cleanup', async () => {
    const provider = Object.assign(new LocalSandboxProvider(new WorktreeManager()), {
      health: vi.fn(async () => ({ status: 'unavailable' as const, message: environment.TOKEN })),
      doctor: vi.fn(async () => [{ check: 'engine', ok: false, detail: environment.TOKEN }]),
      dispose: vi.fn(async () => undefined),
    });
    vi.spyOn(SandboxProviderRegistry.prototype, 'create').mockReturnValue(provider);
    const { runtime, plugins } = await load([config('sandbox.local'), config('credential.enterprise')]);
    expect(provider.health).not.toHaveBeenCalled();
    expect(provider.doctor).not.toHaveBeenCalled();
    await expect(plugins[0].health!()).resolves.toMatchObject({ status: 'unhealthy', message: '[redacted]' });
    await expect(plugins[0].diagnostics!()).resolves.toEqual([{ severity: 'warning', code: 'provider.engine', message: '[redacted]' }]);
    await runtime.close();
    await runtime.close();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  it('resolves home and workspace paths without reading files during construction', async () => {
    const hostExec = vi.fn(async (_command: string, _argv: readonly string[]) => ({ code: 0, stdout: '', stderr: '' }));
    const { runtime } = await load([config('host.ssh'), config('context.project-memory')], { homeDir: '/virtual/home', workspaceRoot: '/virtual/workspace', hostExec });
    expect(hostExec).not.toHaveBeenCalled();
    expect(runtime.getContextProvider('context.project-memory')).toMatchObject({ file: '/virtual/workspace/memory.json' });
    await runtime.getHostProvider('ssh')!.exec('build', ['true']);
    expect(hostExec.mock.calls[0]?.[1]).toContain('/virtual/home/test-keys/id');
  });

  it('adapts evidence bundles using the existing builder and sink', async () => {
    const put = vi.spyOn(TestReportProvider.prototype, 'put').mockResolvedValue({ name: 'proof.json', uri: 'file:///virtual/proof.json' });
    const { runtime } = await load([config('artifact.evidence-bundle')]);
    await expect(runtime.getArtifactProvider('evidence-bundle')!.put({ name: 'proof.json', mediaType: 'text/plain', bytes: new TextEncoder().encode('proof') })).resolves.toMatchObject({ name: 'proof.json' });
    const bundle = JSON.parse(new TextDecoder().decode(put.mock.calls[0][0].bytes));
    expect(bundle).toMatchObject({ recordCount: 1, algorithm: 'sha256' });
  });

  it('preserves concrete retrieval, enterprise credential, policy and object storage behavior', async () => {
    const network = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(new Response('{}'));
    const { runtime } = await load([config('context.retrieval'), config('credential.enterprise'), config('policy.compliance-policy'), config('artifact.object-storage')], { fetch: network });
    await expect(runtime.getContextProvider('context.retrieval')!.gather({ scope: '.', prompt: 'build' })).resolves.toMatchObject([{ origin: 'guide' }]);
    await expect(runtime.getCredentialProvider('credential.enterprise')!.resolve({ name: 'deployment' })).resolves.toEqual({ secret: environment.TOKEN });
    const policy = runtime.getPolicyProvider('compliance-policy')!;
    await expect(policy.evaluate({ action: 'deploy', context: { approved: true } })).resolves.toMatchObject({ allowed: true });
    await expect(policy.evaluate({ action: 'deploy', context: { approved: false } })).resolves.toMatchObject({ allowed: false });
    expect(runtime.getArtifactProvider('object-storage')).toBeInstanceOf(ObjectStorageProvider);
    await runtime.getArtifactProvider('object-storage')!.put({ name: 'file.txt', mediaType: 'text/plain', bytes: new Uint8Array([1]) });
    expect(String(network.mock.calls[0]?.[0])).toBe('https://storage.example.test/bucket/file.txt');
  });
});
