import { describe, expect, it, vi } from 'vitest';
import type { HostConnectionPort } from '@afk/core';
import type {
  ArtifactSink, ContextSource, CredentialProvider, NotificationProvider, PolicyCheckProvider,
  RepositoryProvider, TriggerProvider, VerificationProvider,
} from '../../plugin-sdk/capabilities.js';
import type { IssueTrackerPort } from '../../plugin-sdk/issue-tracker.js';
import { GitHubClient } from '../../infrastructure/github/client.js';
import { invokeCapability } from './operations.js';
import { PluginRuntime } from './runtime.js';

async function fixture() {
  const issue = { id: '1', key: 'APP-1', projectId: 'APP', title: 'Task', description: '', state: 'open', labels: [] };
  const comment = { id: 'comment-1', issueId: '1', body: 'Hello' };
  const link = { id: 'link-1', sourceIssueId: '1', targetIssueId: '2', type: 'blocks' as const };
  const host = { id: 'host-1', alias: 'staging', provider: 'host' };
  const verification = {
    id: 'verification', capabilities: { 'static-analysis': true, 'test-execution': true, 'custom-script': true },
    verify: vi.fn(async () => ({ passed: true, durationMs: 12, output: 'ok', secret: 'discarded' })),
  } satisfies VerificationProvider;
  const notification = {
    id: 'notification', capabilities: { 'direct-message': true, 'channel-post': true, mention: true },
    notify: vi.fn(async () => ({ delivered: true, channel: 'team' })),
  } satisfies NotificationProvider;
  const context = {
    id: 'context', capabilities: { 'read-only': true, summarize: true, search: true },
    gather: vi.fn(async () => [{ content: 'context', origin: 'wiki', secret: 'discarded' }]),
  } satisfies ContextSource;
  const credential = {
    id: 'credential', capabilities: { read: true, rotate: false, 'scoped-token': false },
    resolve: vi.fn(async () => ({ secret: 'credential-value' })),
  } satisfies CredentialProvider;
  const artifact = {
    id: 'artifact', capabilities: { write: true, read: false, list: false },
    put: vi.fn(async () => ({ name: 'report.txt', uri: 'file:///report.txt' })),
  } satisfies ArtifactSink;
  const repository = {
    id: 'repository', capabilities: { read: true, clone: false, push: false },
    snapshot: vi.fn(async () => ({ commit: 'abc123', branch: 'main', dirty: false })),
  } satisfies RepositoryProvider;
  const policy = {
    id: 'policy', capabilities: { 'pre-execution': true, 'post-execution': false, 'static-review': false },
    evaluate: vi.fn(async () => ({ allowed: false, rule: 'deny' })),
  } satisfies PolicyCheckProvider;
  const trigger = {
    id: 'trigger', capabilities: { schedule: true, webhook: true, manual: true },
    register: vi.fn(async () => {}), unregister: vi.fn(async () => {}),
  } satisfies TriggerProvider;
  const tracker = {
    id: 'tracker', projectId: 'APP', baseUrl: 'https://tracker.example',
    getIssue: vi.fn(async () => issue), listIssues: vi.fn(async () => [issue]),
    createIssue: vi.fn(async () => issue), updateIssue: vi.fn(async () => issue), deleteIssue: vi.fn(async () => {}),
    addComment: vi.fn(async () => comment), listComments: vi.fn(async () => [comment]),
    updateComment: vi.fn(async () => comment), deleteComment: vi.fn(async () => {}),
    linkIssues: vi.fn(async () => link), listIssueLinks: vi.fn(async () => [link]),
    health: vi.fn(async () => ({ status: 'ok' as const })), doctor: vi.fn(async () => [{ check: 'auth', ok: true }]),
  } satisfies IssueTrackerPort;
  const hosts = {
    listHosts: vi.fn(async () => [host]), resolve: vi.fn(async () => host),
    exec: vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' })), upload: vi.fn(async () => {}),
  } satisfies HostConnectionPort;
  const runtime = new PluginRuntime();
  await runtime.activate({
    manifest: {
      id: 'test.operations', version: '1.0.0', apiVersion: 1, trusted: true,
      provides: ['verification.provider', 'notification.provider', 'context.provider', 'credential.provider', 'artifact.provider',
        'repository.provider', 'policy.provider', 'trigger.provider', 'tracker.issue', 'host.connection'],
    },
    activate(setup) {
      setup.registerVerificationProvider('verification', verification);
      setup.registerNotificationProvider('notification', notification);
      setup.registerContextProvider('context', context);
      setup.registerCredentialProvider('credential', credential);
      setup.registerArtifactProvider('artifact', artifact);
      setup.registerRepositoryProvider('repository', repository);
      setup.registerPolicyProvider('policy', policy);
      setup.registerTriggerProvider('trigger', trigger);
      setup.registerIssueTrackerProvider('tracker', tracker);
      setup.registerHostProvider('host', hosts);
    },
  });
  return { runtime, verification, notification, context, credential, artifact, repository, policy, trigger, tracker, hosts, issue, comment, link, host };
}

describe('invokeCapability', () => {
  it('forwards validated applicability and target context through the public dispatcher', async () => {
    const current = await fixture();
    const input = { scope: 'github:acme/lesson', prompt: 'retry', applicability: { version: 'fixture-v1', environment: 'test' },
      target: { project: 'github:acme/lesson', revision: 'a'.repeat(40), dirty: false, conditions: { approved: true } } };
    try {
      await invokeCapability(current.runtime, { capability: 'context.provider', provider: 'context', operation: 'gather', input });
      expect(current.context.gather).toHaveBeenCalledWith(input);
    } finally { await current.runtime.close(); }
  });

  it.each([
    { applicability: { version: 1 } },
    { applicability: { version: 'fixture-v1', command: 'untrusted' } },
    { target: { project: 'github:acme/lesson', revision: 'uncommitted' } },
    { target: { project: 'github:acme/lesson', conditions: { approved: 'true' } } },
  ])('rejects invalid applicability context before calling its provider: %j', async context => {
    const current = await fixture();
    try {
      await expect(invokeCapability(current.runtime, { capability: 'context.provider', provider: 'context', operation: 'gather',
        input: { scope: 'github:acme/lesson', prompt: 'retry', ...context } })).rejects.toThrow('Invalid or unsupported capability invocation');
      expect(current.context.gather).not.toHaveBeenCalled();
    } finally { await current.runtime.close(); }
  });

  it.each(['scope', 'prompt', 'limit', 'applicability', 'target'] as const)(
    'rejects inherited context %s before calling its provider', async field => {
      const current = await fixture();
      const query = { scope: 'github:acme/lesson', prompt: 'retry', limit: 1, applicability: { version: 'fixture-v1' },
        target: { project: 'github:acme/lesson', revision: 'a'.repeat(40), dirty: false } };
      const input = Object.assign(Object.create({ [field]: query[field] }),
        Object.fromEntries(Object.entries(query).filter(([key]) => key !== field)));
      try {
        expect(Object.hasOwn(input, field)).toBe(false);
        await expect(invokeCapability(current.runtime, { capability: 'context.provider', provider: 'context', operation: 'gather', input }))
          .rejects.toThrow('Invalid or unsupported capability invocation');
        expect(current.context.gather).not.toHaveBeenCalled();
      } finally { await current.runtime.close(); }
    });

  it.each(['scope', 'prompt', 'limit', 'applicability', 'target'] as const)(
    'rejects inherited context %s getters without evaluating them', async field => {
      const current = await fixture();
      const getter = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE_CONTEXT'); });
      const prototype = Object.defineProperty({}, field, { enumerable: true, get: getter });
      const input = Object.assign(Object.create(prototype),
        Object.fromEntries(Object.entries({ scope: 'github:acme/lesson', prompt: 'retry' }).filter(([key]) => key !== field)));
      try {
        await expect(invokeCapability(current.runtime, { capability: 'context.provider', provider: 'context', operation: 'gather', input }))
          .rejects.toThrow('Invalid or unsupported capability invocation');
        expect(getter).not.toHaveBeenCalled();
        expect(current.context.gather).not.toHaveBeenCalled();
      } finally { await current.runtime.close(); }
    });

  it.each(['capability', 'input'] as const)('rejects inherited invocation %s before parsing context', async field => {
    const current = await fixture();
    const getter = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE_CONTEXT'); });
    const query = Object.defineProperty({ scope: 'github:acme/lesson', prompt: 'retry' }, 'target', { get: getter });
    const request = { capability: 'context.provider', provider: 'context', operation: 'gather', input: query };
    const input = Object.assign(Object.create({ [field]: request[field] }),
      Object.fromEntries(Object.entries(request).filter(([key]) => key !== field)));
    try {
      await expect(invokeCapability(current.runtime, input)).rejects.toThrow('Invalid or unsupported capability invocation');
      expect(getter).not.toHaveBeenCalled();
      expect(current.context.gather).not.toHaveBeenCalled();
    } finally { await current.runtime.close(); }
  });

  it('rejects own context target getters without evaluating them', async () => {
    const current = await fixture();
    const getter = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE_CONTEXT'); });
    const input = Object.defineProperty({ scope: 'github:acme/lesson', prompt: 'retry' }, 'target', { get: getter });
    try {
      await expect(invokeCapability(current.runtime, { capability: 'context.provider', provider: 'context', operation: 'gather', input }))
        .rejects.toThrow('Invalid or unsupported capability invocation');
      expect(getter).not.toHaveBeenCalled();
      expect(current.context.gather).not.toHaveBeenCalled();
    } finally { await current.runtime.close(); }
  });

  it('accepts own context fields on null-prototype objects', async () => {
    const current = await fixture();
    const input = Object.assign(Object.create(null), { scope: 'github:acme/lesson', prompt: 'retry',
      target: { project: 'github:acme/lesson', revision: 'a'.repeat(40), dirty: false } });
    const request = Object.assign(Object.create(null), { capability: 'context.provider', provider: 'context', operation: 'gather', input });
    try {
      await invokeCapability(current.runtime, request);
      expect(current.context.gather).toHaveBeenCalledWith(input);
    } finally { await current.runtime.close(); }
  });

  it('dispatches repository lifecycle and its execution callback in one resident runtime', async () => {
    const { runtime } = await fixture();
    const workspace = { id: 'owned', repository: { url: 'api' }, runId: 'run-1', snapshot: { commit: 'abc', branch: 'afk/run-1', dirty: false }, path: '/owned/api' };
    const prepare = vi.fn(async () => workspace);
    const checkout = vi.fn(async () => workspace);
    const publish = vi.fn(async () => ({ commit: 'abc', branch: 'afk/run-1' }));
    const cleanup = vi.fn(async () => ({ removed: true }));
    const execute = vi.fn(async () => ({ passed: true }));
    await runtime.activate({ manifest: { id: 'repository.lifecycle', version: '1.0.0', apiVersion: 1, provides: ['repository.provider', 'workflow.action'], trusted: true }, activate(context) {
      context.registerRepositoryProvider('managed', { id: 'managed', capabilities: { read: true, clone: true, push: true, prepare: true, checkout: true, publish: true, cleanup: true }, snapshot: async () => workspace.snapshot, prepare, checkout, publish, cleanup });
      context.registerSystemAction('repository.verify', execute);
    } });
    try {
      await expect(invokeCapability(runtime, { capability: 'repository.provider', provider: 'repository', operation: 'prepare', input: { repository: { url: 'api' }, runId: 'run-1' } })).rejects.toThrow('does not support');
      const result = await invokeCapability(runtime, { capability: 'repository.provider', provider: 'managed', operation: 'run', input: { repository: { url: 'api' }, runId: 'run-1', action: 'repository.verify', input: { target: 'all' } } });
      expect(result).toMatchObject({ value: { passed: true }, publication: { commit: 'abc' }, cleanup: { removed: true } });
      expect(execute).toHaveBeenCalledWith({ input: { target: 'all' }, repositoryWorkspace: workspace, worktreePath: '/owned/api' });
      expect(prepare).toHaveBeenCalledWith({ repository: { url: 'api' }, runId: 'run-1' }, undefined);
      for (const [operation, input] of [['prepare', { repository: { url: 'api' }, runId: 'run-1' }], ['checkout', { workspaceId: 'owned' }], ['publish', { workspaceId: 'owned' }], ['cleanup', { workspaceId: 'owned' }]] as const) {
        await invokeCapability(runtime, { capability: 'repository.provider', provider: 'managed', operation, input });
      }
      await expect(invokeCapability(runtime, { capability: 'repository.provider', provider: 'managed', operation: 'run', input: { repository: { url: 'api' }, runId: 'run-1', action: 'missing', input: {} } })).rejects.toThrow('not registered');
    } finally { await runtime.dispose(); }
  });
  it('calls typed verification, notification, context, repository and policy providers and projects results', async () => {
    const { runtime, verification, notification, context, repository, policy } = await fixture();
    const cases = [
      ['verification.provider', 'verification', 'verify', { target: '/repo', command: ['test', ''], timeoutMs: 10 }, verification.verify, { passed: true, durationMs: 12, output: 'ok' }],
      ['notification.provider', 'notification', 'notify', { title: 'Done', body: 'Report', urgency: 'high' }, notification.notify, { delivered: true, channel: 'team' }],
      ['context.provider', 'context', 'gather', { scope: '.', prompt: 'Task', limit: 2 }, context.gather, [{ content: 'context', origin: 'wiki' }]],
      ['repository.provider', 'repository', 'snapshot', { url: '/repo', ref: 'main' }, repository.snapshot, { commit: 'abc123', branch: 'main', dirty: false }],
      ['policy.provider', 'policy', 'evaluate', { action: 'execute', context: { iid: 1, sandboxed: true } }, policy.evaluate, { allowed: false, rule: 'deny' }],
    ] as const;
    for (const [capability, provider, operation, input, method, result] of cases) {
      await expect(invokeCapability(runtime, { capability, provider, operation, input })).resolves.toEqual(result);
      expect(method).toHaveBeenCalledTimes(1);
      expect(method).toHaveBeenCalledWith(input);
    }
  });

  it('decodes binary and empty base64 artifacts', async () => {
    const { runtime, artifact } = await fixture();
    for (const bytes of [Buffer.from([0, 255, 128, 10]), Buffer.alloc(0)]) {
      await expect(invokeCapability(runtime, {
        capability: 'artifact.provider', provider: 'artifact', operation: 'put',
        input: { name: 'report.txt', mediaType: 'application/octet-stream', bytes: bytes.toString('base64') },
      })).resolves.toEqual({ name: 'report.txt', uri: 'file:///report.txt' });
      expect(artifact.put).toHaveBeenLastCalledWith({ name: 'report.txt', mediaType: 'application/octet-stream', bytes });
    }
  });

  it('registers and unregisters typed triggers', async () => {
    const { runtime, trigger } = await fixture();
    const input = { id: 'nightly', kind: 'schedule', schedule: '0 0 * * *', payload: { enabled: true } };
    await invokeCapability(runtime, { capability: 'trigger.provider', provider: 'trigger', operation: 'register', input });
    await invokeCapability(runtime, { capability: 'trigger.provider', provider: 'trigger', operation: 'unregister', input: { triggerId: 'nightly' } });
    expect(trigger.register).toHaveBeenCalledWith(input);
    expect(trigger.unregister).toHaveBeenCalledWith('nightly');
  });

  it('routes every issue CRUD, comment, relation and diagnostic operation with positional arguments', async () => {
    const { runtime, tracker, issue, comment, link } = await fixture();
    const cases = [
      ['getIssue', { issueId: '1' }, ['1'], issue],
      ['listIssues', { state: 'open', labels: ['bug'], limit: 2, cursor: 'next' }, [{ state: 'open', labels: ['bug'], limit: 2, cursor: 'next' }], [issue]],
      ['createIssue', { title: 'Task', issueType: 'Bug', description: 'Body', labels: ['bug'] }, [{ title: 'Task', issueType: 'Bug', description: 'Body', labels: ['bug'] }], issue],
      ['updateIssue', { issueId: '1', input: { title: 'New', description: '', labels: [], state: 'done' } }, ['1', { title: 'New', description: '', labels: [], state: 'done' }], issue],
      ['deleteIssue', { issueId: '1' }, ['1'], undefined],
      ['addComment', { issueId: '1', body: 'Hello' }, ['1', 'Hello'], comment],
      ['listComments', { issueId: '1' }, ['1'], [comment]],
      ['updateComment', { issueId: '1', commentId: 'comment-1', body: 'Hello' }, ['1', 'comment-1', 'Hello'], comment],
      ['deleteComment', { issueId: '1', commentId: 'comment-1' }, ['1', 'comment-1'], undefined],
      ['linkIssues', { sourceIssueId: '1', targetIssueId: '2', type: 'blocks' }, ['1', '2', 'blocks'], link],
      ['listIssueLinks', { issueId: '1' }, ['1'], [link]],
      ['health', {}, [], { status: 'ok' }],
      ['doctor', {}, [], [{ check: 'auth', ok: true }]],
    ] as const;
    for (const [operation, input, args, result] of cases) {
      await expect(invokeCapability(runtime, { capability: 'tracker.issue', provider: 'tracker', operation, input })).resolves.toEqual(result);
      expect(tracker[operation]).toHaveBeenCalledTimes(1);
      expect(tracker[operation]).toHaveBeenCalledWith(...args);
    }
  });

  it('reuses the host boundary and preserves argv and upload arguments', async () => {
    const { runtime, hosts, host } = await fixture();
    const cases = [
      ['listHosts', {}, [], [host]],
      ['resolve', { host: 'staging' }, ['staging'], host],
      ['exec', { host: 'staging', argv: ['printf', 'a b'], timeoutMs: 20 }, ['staging', ['printf', 'a b'], { timeoutMs: 20 }], { code: 0, stdout: 'ok', stderr: '' }],
      ['upload', { host: 'staging', source: '/local', destination: '/remote', timeoutMs: 20 }, ['staging', '/local', '/remote', { timeoutMs: 20 }], undefined],
    ] as const;
    for (const [operation, input, args, result] of cases) {
      await expect(invokeCapability(runtime, { capability: 'host.connection', provider: 'host', operation, input })).resolves.toEqual(result);
      expect(hosts[operation]).toHaveBeenCalledTimes(1);
      expect(hosts[operation]).toHaveBeenCalledWith(...args);
    }
  });

  it('dispatches legacy tracker queries and edits with numeric issues and native return types', async () => {
    const { runtime } = await fixture();
    const tracker = new GitHubClient({ repo: 'org/repo', auth: 'test-placeholder' });
    const issue = { id: 42, platform: 'github' as const, title: 'Task', description: '', labels: [], state: 'opened' as const, url: 'https://github.com/org/repo/issues/42', projectId: 'org/repo' };
    const change = { id: 7, platform: 'github' as const, title: 'Change', state: 'opened' as const, sourceBranch: 'feat/42', targetBranch: 'main', url: 'https://github.com/org/repo/pull/7', projectId: 'org/repo' };
    const methods = {
      getIssue: vi.spyOn(tracker, 'getIssue').mockResolvedValue(issue),
      listIssues: vi.spyOn(tracker, 'listIssues').mockResolvedValue([issue]),
      createIssue: vi.spyOn(tracker, 'createIssue').mockResolvedValue(42),
      updateIssue: vi.spyOn(tracker, 'updateIssue').mockResolvedValue(undefined),
      updateLabels: vi.spyOn(tracker, 'updateLabels').mockResolvedValue(undefined),
      addLabel: vi.spyOn(tracker, 'addLabel').mockResolvedValue(undefined),
      removeLabel: vi.spyOn(tracker, 'removeLabel').mockResolvedValue(undefined),
      addComment: vi.spyOn(tracker, 'addComment').mockResolvedValue(undefined),
      listIssueComments: vi.spyOn(tracker, 'listIssueComments').mockResolvedValue([{ id: 'comment-1', body: 'hello' }]),
      updateIssueComment: vi.spyOn(tracker, 'updateIssueComment').mockResolvedValue(undefined),
      linkIssues: vi.spyOn(tracker, 'linkIssues').mockResolvedValue(undefined),
      getMR: vi.spyOn(tracker, 'getMR').mockResolvedValue(change),
      listMRs: vi.spyOn(tracker, 'listMRs').mockResolvedValue([change]),
      createMR: vi.spyOn(tracker, 'createMR').mockResolvedValue(7),
      updateMR: vi.spyOn(tracker, 'updateMR').mockResolvedValue(undefined),
      closeMR: vi.spyOn(tracker, 'closeMR').mockResolvedValue(undefined),
      reopenMR: vi.spyOn(tracker, 'reopenMR').mockResolvedValue(undefined),
      isMRLinkedToIssue: vi.spyOn(tracker, 'isMRLinkedToIssue').mockResolvedValue(true),
    };
    const merge = vi.spyOn(tracker, 'mergeMR');
    await runtime.activate({
      manifest: { id: 'test.legacy-tracker', version: '1.0.0', apiVersion: 1, provides: ['tracker.provider'], trusted: true },
      activate: setup => setup.registerTrackerProvider('github', tracker),
    });
    const cases = [
      ['getIssue', { id: 42 }, [42], issue],
      ['listIssues', { state: 'opened', labels: ['bug'], perPage: 5, projectId: 'org/repo' }, [{ state: 'opened', labels: ['bug'], perPage: 5, projectId: 'org/repo' }], [issue]],
      ['createIssue', { title: 'Task', description: 'Body', labels: ['bug'] }, [{ title: 'Task', description: 'Body', labels: ['bug'] }], 42],
      ['updateIssue', { id: 42, updates: { state: 'closed', labels: [] } }, [42, { state: 'closed', labels: [] }], undefined],
      ['updateLabels', { id: 42, delta: { add: ['new'], remove: ['old'] } }, [42, { add: ['new'], remove: ['old'] }], undefined],
      ['addLabel', { id: 42, label: 'bug' }, [42, 'bug'], undefined],
      ['removeLabel', { id: 42, label: 'bug' }, [42, 'bug'], undefined],
      ['addComment', { id: 42, body: 'hello' }, [42, 'hello'], undefined],
      ['listIssueComments', { id: 42 }, [42], [{ id: 'comment-1', body: 'hello' }]],
      ['updateIssueComment', { id: 42, commentId: 'comment-1', body: 'hello' }, [42, 'comment-1', 'hello'], undefined],
      ['linkIssues', { sourceId: 42, targetId: 43, type: 'blocked_by', targetProjectId: 'org/other' }, [42, 43, 'blocked_by', 'org/other'], undefined],
      ['getMR', { id: 7 }, [7], change],
      ['listMRs', { state: 'opened', perPage: 2 }, [{ state: 'opened', perPage: 2 }], [change]],
      ['createMR', { title: 'Change', sourceBranch: 'feat/42', targetBranch: 'main', draft: true }, [{ title: 'Change', sourceBranch: 'feat/42', targetBranch: 'main', draft: true }], 7],
      ['updateMR', { id: 7, updates: { description: 'evidence' } }, [7, { description: 'evidence' }], undefined],
      ['closeMR', { id: 7, comment: 'superseded' }, [7, { comment: 'superseded' }], undefined],
      ['reopenMR', { id: 7 }, [7], undefined],
      ['isMRLinkedToIssue', { id: 7, canonicalWorkItemId: 'github:org/repo#42' }, [7, 'github:org/repo#42'], true],
    ] as const;
    for (const [operation, input, args, result] of cases) {
      await expect(invokeCapability(runtime, { capability: 'tracker.provider', provider: 'github', operation, input })).resolves.toEqual(result);
      expect(methods[operation]).toHaveBeenCalledTimes(1);
      expect(methods[operation]).toHaveBeenCalledWith(...args);
    }
    for (const operation of ['mergeMR', 'approveMR', 'deleteIssue']) {
      await expect(invokeCapability(runtime, { capability: 'tracker.provider', provider: 'github', operation, input: { id: 7 } })).rejects.toThrow('unsupported');
    }
    expect(merge).not.toHaveBeenCalled();
    Object.defineProperty(tracker, 'updateMR', { value: undefined });
    await expect(invokeCapability(runtime, {
      capability: 'tracker.provider', provider: 'github', operation: 'updateMR', input: { id: 7, updates: { description: '' } },
    })).rejects.toThrow('does not support updateMR');
  });

  it.each([
    null, [], 'verify', {},
    { capability: 'credential.provider', provider: 'credential', operation: 'resolve', input: { name: 'token', secret: 'credential-value' } },
    { capability: 'verification.provider', provider: 'verification', operation: 'constructor', input: {} },
    { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo', timeoutMs: '1' } },
    { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo', timeoutMs: -1 } },
    { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo', command: [] } },
    { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo', command: [''] } },
    { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo', command: ['test\0'] } },
    { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo', secret: 'credential-value' } },
    { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo' }, secret: 'credential-value' },
    { capability: 'artifact.provider', provider: 'artifact', operation: 'put', input: { name: 'r', mediaType: 'text/plain', bytes: '@@@' } },
    { capability: 'artifact.provider', provider: 'artifact', operation: 'put', input: { name: 'r', mediaType: 'text/plain', bytes: 'AB==' } },
    { capability: 'artifact.provider', provider: 'artifact', operation: 'put', input: { name: 'r', mediaType: 'text/plain', bytes: [1, 2] } },
    { capability: 'tracker.issue', provider: 'tracker', operation: 'updateIssue', input: { issueId: '1', input: { title: 'T', secret: 'credential-value' } } },
    { capability: 'tracker.issue', provider: 'tracker', operation: 'linkIssues', input: { sourceIssueId: '1', targetIssueId: '2', type: 'parent' } },
    { capability: 'tracker.provider', provider: 'github', operation: 'getIssue', input: { id: '42' } },
    { capability: 'tracker.provider', provider: 'github', operation: 'getIssue', input: { id: -1 } },
    { capability: 'tracker.provider', provider: 'github', operation: 'updateIssue', input: { id: 42, updates: { state: 'opened' } } },
    { capability: 'tracker.provider', provider: 'github', operation: 'linkIssues', input: { sourceId: 42, targetId: 43, type: 'blocked-by' } },
    { capability: 'trigger.provider', provider: 'trigger', operation: 'register', input: { id: 't', kind: 'manual', payload: { nested: undefined } } },
    { capability: 'host.connection', provider: 'host', operation: 'exec', input: { host: 'staging', argv: 'echo test' } },
  ])('rejects invalid input before any provider call (%#)', async input => {
    const providers = await fixture();
    await expect(invokeCapability(providers.runtime, input)).rejects.toThrow('Invalid or unsupported capability invocation');
    for (const provider of Object.values(providers)) {
      for (const method of Object.values(provider)) if (vi.isMockFunction(method)) expect(method).not.toHaveBeenCalled();
    }
    await invokeCapability(providers.runtime, input).catch(error => expect(String(error)).not.toContain('credential-value'));
  });

  it('rejects absent providers and unsupported optional host upload', async () => {
    const { runtime } = await fixture();
    await expect(invokeCapability(runtime, {
      capability: 'verification.provider', provider: 'missing', operation: 'verify', input: { target: '/repo' },
    })).rejects.toThrow('not registered');
    await runtime.activate({
      manifest: { id: 'host.readonly', version: '1.0.0', apiVersion: 1, provides: ['host.connection'], trusted: true },
      activate: setup => setup.registerHostProvider('readonly', {
        listHosts: async () => [], resolve: async () => ({ id: '1', alias: '1', provider: 'readonly' }),
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
    });
    await expect(invokeCapability(runtime, {
      capability: 'host.connection', provider: 'readonly', operation: 'upload', input: { host: '1', source: '/a', destination: '/b' },
    })).rejects.toThrow('does not support upload');
  });

  it('propagates provider failures and refuses malformed results', async () => {
    const { runtime, verification } = await fixture();
    verification.verify.mockRejectedValueOnce(new Error('provider failed'));
    const input = { capability: 'verification.provider', provider: 'verification', operation: 'verify', input: { target: '/repo' } };
    await expect(invokeCapability(runtime, input)).rejects.toThrow('provider failed');
    verification.verify.mockResolvedValueOnce({ passed: 'credential-value' } as unknown as Awaited<ReturnType<typeof verification.verify>>);
    await expect(invokeCapability(runtime, input)).rejects.toThrow('Invalid capability result');
  });
});
