import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryProvider, RepositoryCapability, RepositoryWorkspace, RepositoryLifecycleOperation } from '../../plugin-sdk/capabilities.js';
import {
  MultiRepositoryProvider,
  RepositoryPreparationCleanupError,
  RemoteWorkspaceProvider,
  SpecialGitBackendProvider,
} from './repositories.js';
import { executeCommand, type CommandExecutor, type CommandResult, type FetchTransport } from './dependencies.js';
import { RepositoryLeases } from '../git/repository-lease.js';
import { RepositoryStore } from '../git/repository-store.js';
import { RepositoryLifecycleService } from '../../application/plugins/repository-lifecycle.js';

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), prefix));
  dirs.push(path);
  return path;
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); })); });

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

/** Drives real git through the shared executor to build an offline fixture. */
async function git(cwd: string, args: readonly string[], input?: string): Promise<CommandResult> {
  return executeCommand({ command: 'git', args, cwd, input });
}

/** Creates a real git repository with one commit; returns its path and HEAD. */
async function initRepo(name = 'repo'): Promise<{ path: string; head: string; branch: string }> {
  const path = await tempDir('afk-repo-');
  await git(path, ['init', '--quiet']);
  await git(path, ['config', 'user.email', 'test@example.com']);
  await git(path, ['config', 'user.name', 'Test']);
  await fs.writeFile(join(path, 'README.md'), '# fixture\n', 'utf8');
  await git(path, ['add', 'README.md']);
  await git(path, ['commit', '-m', 'init', '--quiet']);
  const head = (await git(path, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  return { path, head, branch };
}

function expectSnapshotOnly(provider: RepositoryProvider): void {
  const record = provider.capabilities as Readonly<Record<RepositoryCapability, boolean>>;
  expect(record.read).toBe(true);
  expect(record.clone).toBe(false);
  expect(record.push).toBe(false);
}

function staticExecutor(result: Partial<CommandResult>): { executor: CommandExecutor; calls: Array<{ command: string; args: readonly string[]; cwd?: string }> } {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  const executor: CommandExecutor = async request => {
    calls.push({ command: request.command, args: request.args, cwd: request.cwd });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { executor, calls };
}

function fakeTransport(body: unknown, status = 200): { transport: FetchTransport; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = (async (input: unknown, init: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as FetchTransport;
  return { transport, calls };
}

describe('MultiRepositoryProvider', () => {
  it('snapshots a real configured local repository', async () => {
    const repo = await initRepo();
    const provider = new MultiRepositoryProvider({
      repositories: [{ name: 'app', path: repo.path }],
    });
    const snapshot = await provider.snapshot({ url: 'app' });
    expect(snapshot.commit).toBe(repo.head);
    expect(snapshot.branch).toBe(repo.branch);
    expect(snapshot.dirty).toBe(false);
    expectSnapshotOnly(provider);
  });

  it('reports a dirty working tree', async () => {
    const repo = await initRepo();
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'app', path: repo.path }] });
    await fs.writeFile(join(repo.path, 'README.md'), '# changed\n', 'utf8');
    const snapshot = await provider.snapshot({ url: 'app' });
    expect(snapshot.dirty).toBe(true);
    expect(snapshot.commit).toBe(repo.head);
  });

  it('matches a configured repository by path as well as by name', async () => {
    const repo = await initRepo();
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'app', path: repo.path }] });
    const snapshot = await provider.snapshot({ url: repo.path });
    expect(snapshot.commit).toBe(repo.head);
  });

  it('rejects a repository that is not configured', async () => {
    const repo = await initRepo();
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'app', path: repo.path }] });
    await expect(provider.snapshot({ url: 'other' })).rejects.toThrow(/not configured for snapshot/);
  });

  it('uses the injected git executor with the repository cwd', async () => {
    const { executor, calls } = staticExecutor({ stdout: 'abc123\n' });
    // Second/third calls need distinct outputs; drive them by argument.
    const executor2: CommandExecutor = async request => {
      calls.push({ command: request.command, args: request.args, cwd: request.cwd });
      if (request.args.includes('HEAD') && !request.args.includes('--abbrev-ref')) {
        return { stdout: 'abc123\n', stderr: '' };
      }
      if (request.args.includes('--abbrev-ref')) return { stdout: 'feature\n', stderr: '' };
      return { stdout: ' M file\n', stderr: '' };
    };
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'app', path: '/srv/app' }], git: executor2 });
    const snapshot = await provider.snapshot({ url: 'app' });
    expect(snapshot).toEqual({ commit: 'abc123', branch: 'feature', dirty: true });
    expect(calls.every(call => call.command === 'git')).toBe(true);
    expect(calls.every(call => call.cwd === '/srv/app')).toBe(true);
    expect(calls[0].args).toEqual(['rev-parse', 'HEAD']);
    expect(calls).toHaveLength(3);
    expect(executor).toBeDefined();
  });

  it('propagates a git failure from the injected executor', async () => {
    const executor: CommandExecutor = async () => {
      throw new Error('git exploded');
    };
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'app', path: '/srv/app' }], git: executor });
    await expect(provider.snapshot({ url: 'app' })).rejects.toThrow('git exploded');
  });

  it('honours cancellation', async () => {
    let ran = false;
    const executor: CommandExecutor = async () => {
      ran = true;
      return { stdout: 'x\n', stderr: '' };
    };
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'app', path: '/srv/app' }], git: executor });
    const controller = new AbortController();
    controller.abort(new Error('cancel'));
    await expect(provider.snapshot({ url: 'app' }, { signal: controller.signal })).rejects.toThrow('cancel');
    expect(ran).toBe(false);
  });
});

describe('RemoteWorkspaceProvider', () => {
  const baseUrl = 'https://workspace.example/api';

  it('snapshots via the workspace API and validates the response', async () => {
    const { transport, calls } = fakeTransport({ commit: 'deadbeef', branch: 'main', dirty: false });
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport, token: 't' });
    const snapshot = await provider.snapshot({ url: 'ws-42' });
    expect(snapshot).toEqual({ commit: 'deadbeef', branch: 'main', dirty: false });
    expect(calls[0].url).toBe('https://workspace.example/api/workspaces/ws-42/snapshot');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expectSnapshotOnly(provider);
  });

  it('keeps a workspace name with a slash and space as one encoded path segment', async () => {
    const { transport, calls } = fakeTransport({ commit: 'deadbeef', branch: 'main', dirty: false });
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport });
    await expect(provider.snapshot({ url: 'team/repo with space' })).resolves.toMatchObject({ commit: 'deadbeef' });
    expect(calls[0].url).toBe('https://workspace.example/api/workspaces/team%2Frepo%20with%20space/snapshot');
  });

  it('rejects invalid JSON', async () => {
    const transport = (async () => new Response('<html>not json</html>', { status: 200 })) as FetchTransport;
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport });
    await expect(provider.snapshot({ url: 'ws-42' })).rejects.toThrow(/invalid JSON/);
  });

  it('rejects a response missing the dirty flag', async () => {
    const { transport } = fakeTransport({ commit: 'deadbeef', branch: 'main' });
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport });
    await expect(provider.snapshot({ url: 'ws-42' })).rejects.toThrow(/missing a dirty flag/);
  });

  it('rejects a response with an empty commit', async () => {
    const { transport } = fakeTransport({ commit: '  ', branch: 'main', dirty: false });
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport });
    await expect(provider.snapshot({ url: 'ws-42' })).rejects.toThrow(/missing a commit/);
  });

  it('rejects a non-ok response', async () => {
    const { transport } = fakeTransport({ message: 'nope' }, 404);
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport });
    await expect(provider.snapshot({ url: 'ws-42' })).rejects.toThrow(/failed \(404\)/);
  });

  it('uses global fetch at snapshot time', async () => {
    const fetch = vi.fn(async () => new Response('{"commit":"c","branch":"main","dirty":false}'));
    vi.stubGlobal('fetch', fetch);
    const provider = new RemoteWorkspaceProvider({ baseUrl });
    expect(fetch).not.toHaveBeenCalled();
    expect(await provider.snapshot({ url: 'ws-42' })).toEqual({ commit: 'c', branch: 'main', dirty: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('honours cancellation', async () => {
    const { transport, calls } = fakeTransport({ commit: 'a', branch: 'b', dirty: false });
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport });
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(provider.snapshot({ url: 'ws-42' }, { signal: controller.signal })).rejects.toThrow('stop');
    expect(calls).toEqual([]);
  });
});

describe('SpecialGitBackendProvider', () => {
  it('snapshots via the injected backend command and validates JSON', async () => {
    const { executor, calls } = staticExecutor({ stdout: '{"commit":"c0ffee","branch":"josh","dirty":true}' });
    const provider = new SpecialGitBackendProvider({ backend: 'josh-snapshot', executor });
    const snapshot = await provider.snapshot({ url: 'https://example.com/repo.git', ref: 'v1' });
    expect(snapshot).toEqual({ commit: 'c0ffee', branch: 'josh', dirty: true });
    expect(calls[0].command).toBe('josh-snapshot');
    expect(calls[0].args).toEqual(['snapshot', '--json', 'https://example.com/repo.git', '--ref', 'v1']);
    expectSnapshotOnly(provider);
  });

  it('passes an absolute local checkout path as one argv element', async () => {
    const { executor, calls } = staticExecutor({ stdout: '{"commit":"c0ffee","branch":"main","dirty":false}' });
    const provider = new SpecialGitBackendProvider({ backend: 'josh-snapshot', executor });
    await provider.snapshot({ url: '/tmp/afk-checkouts/repo with space' });
    expect(calls[0].args).toEqual(['snapshot', '--json', '/tmp/afk-checkouts/repo with space']);
  });

  it('omits --ref when no ref is supplied', async () => {
    const { executor, calls } = staticExecutor({ stdout: '{"commit":"c0ffee","branch":"main","dirty":false}' });
    const provider = new SpecialGitBackendProvider({ backend: 'josh-snapshot', executor });
    await provider.snapshot({ url: 'https://example.com/repo.git' });
    expect(calls[0].args).toEqual(['snapshot', '--json', 'https://example.com/repo.git']);
  });

  it('rejects invalid JSON from the backend', async () => {
    const { executor } = staticExecutor({ stdout: 'not json' });
    const provider = new SpecialGitBackendProvider({ backend: 'josh-snapshot', executor });
    await expect(provider.snapshot({ url: 'repo' })).rejects.toThrow(/invalid JSON/);
  });

  it('rejects a well-formed but incomplete snapshot', async () => {
    const { executor } = staticExecutor({ stdout: '{"commit":"c0ffee"}' });
    const provider = new SpecialGitBackendProvider({ backend: 'josh-snapshot', executor });
    await expect(provider.snapshot({ url: 'repo' })).rejects.toThrow(/missing a branch/);
  });

  it('honours cancellation before invoking the backend', async () => {
    let ran = false;
    const executor: CommandExecutor = async () => {
      ran = true;
      return { stdout: '{"commit":"c","branch":"b","dirty":false}', stderr: '' };
    };
    const provider = new SpecialGitBackendProvider({ backend: 'josh-snapshot', executor });
    const controller = new AbortController();
    controller.abort(new Error('cancel'));
    await expect(provider.snapshot({ url: 'repo' }, { signal: controller.signal })).rejects.toThrow('cancel');
    expect(ran).toBe(false);
  });
});

describe('repository failure boundaries', () => {
  it.each(['.', '..', '../repo', '%2e%2e', 'https://user:secret@workspace.example'])('rejects unsafe workspace snapshot identifiers %s', async url => {
    const transport = vi.fn(async () => new Response('{}'));
    const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport });
    await expect(provider.snapshot({ url })).rejects.toThrow(/identifier/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not silently snapshot HEAD for an unsupported requested ref', async () => {
    const { executor, calls } = staticExecutor({ stdout: 'head' });
    const local = new MultiRepositoryProvider({ repositories: [{ name: 'repo', path: '/tmp/repo' }], git: executor });
    const fetch = vi.fn(async () => new Response('{}'));
    const remote = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example/api', transport: fetch });
    await expect(local.snapshot({ url: 'repo', ref: 'other' })).rejects.toThrow(/specific ref is not supported/);
    await expect(remote.snapshot({ url: 'ws', ref: 'other' })).rejects.toThrow(/specific ref is not supported/);
    expect(calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate repository names and captures configuration by value', async () => {
    const config = { name: 'repo', path: '/tmp/repo' };
    expect(() => new MultiRepositoryProvider({ repositories: [config, config] })).toThrow(/duplicate/);
    const { executor, calls } = staticExecutor({ stdout: 'head' });
    const provider = new MultiRepositoryProvider({ repositories: [config], git: executor });
    config.path = '/unconfigured';
    await provider.snapshot({ url: 'repo' });
    expect(calls.every(call => call.cwd === '/tmp/repo')).toBe(true);
  });

  it('propagates git command failure without executing later commands', async () => {
    const executor = vi.fn<Parameters<CommandExecutor>, ReturnType<CommandExecutor>>(async () => { throw new Error('git failed'); });
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'repo', path: '/tmp/repo' }], git: executor });
    await expect(provider.snapshot({ url: 'repo' })).rejects.toThrow('git failed');
    expect(executor).toHaveBeenCalledOnce();
  });

  it('checks cancellation after an injected executor resolves', async () => {
    const controller = new AbortController();
    const executor = vi.fn<Parameters<CommandExecutor>, ReturnType<CommandExecutor>>(async () => {
      controller.abort(new Error('cancelled during command'));
      return { stdout: '{"commit":"c","branch":"main","dirty":false}', stderr: '' };
    });
    const local = new MultiRepositoryProvider({ repositories: [{ name: 'repo', path: '/tmp/repo' }], git: executor });
    await expect(local.snapshot({ url: 'repo' }, { signal: controller.signal })).rejects.toThrow('cancelled during command');
    expect(executor).toHaveBeenCalledOnce();
    const second = new AbortController();
    const backend = new SpecialGitBackendProvider({ backend: 'snapshot', executor: async () => {
      second.abort(new Error('backend cancelled'));
      return { stdout: '{"commit":"c","branch":"main","dirty":false}', stderr: '' };
    } });
    await expect(backend.snapshot({ url: 'repo' }, { signal: second.signal })).rejects.toThrow('backend cancelled');
  });

  it.each(['http://workspace.example/api', 'https://user:password@workspace.example/api', 'https://workspace.example/api?key=secret'])('rejects unsafe bearer endpoint %s before transport', async baseUrl => {
    const fetch = vi.fn(async () => new Response('{}'));
    const provider = new RemoteWorkspaceProvider({ baseUrl, transport: fetch, token: 'secret' });
    await expect(provider.snapshot({ url: 'ws' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, [], { commit: 'c', branch: 'b', dirty: 'false' }])('rejects invalid remote snapshot %j', async payload => {
    const { transport } = fakeTransport(payload);
    const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport });
    await expect(provider.snapshot({ url: 'ws' })).rejects.toThrow(/snapshot/);
  });

  it('does not pass option-like repository identifiers to a backend', async () => {
    const { executor, calls } = staticExecutor({ stdout: '{}' });
    const provider = new SpecialGitBackendProvider({ backend: 'snapshot', executor });
    await expect(provider.snapshot({ url: '--execute' })).rejects.toThrow(/identifier/);
    await expect(provider.snapshot({ url: 'repo', ref: '--execute' })).rejects.toThrow(/ref/);
    expect(calls).toEqual([]);
  });

  it('redacts backend snapshot failures and rejects credential-bearing URLs before execution', async () => {
    const executor = vi.fn<Parameters<CommandExecutor>, ReturnType<CommandExecutor>>(async () => { throw new Error('token=secret'); });
    const provider = new SpecialGitBackendProvider({ backend: 'snapshot', executor });
    await expect(provider.snapshot({ url: 'https://user:secret@git.example/repo.git' })).rejects.toThrow('invalid repository lifecycle URL');
    expect(executor).not.toHaveBeenCalled();
    await expect(provider.snapshot({ url: 'repo' })).rejects.toThrow('special git backend snapshot command failed');
  });
});

const initialCommit = 'a'.repeat(40);
const publishedCommit = 'b'.repeat(40);
const prepareInput = { repository: { url: 'repo', ref: 'main' }, runId: 'run-1' };
const workspaceRequest = { workspaceId: 'workspace-1' };
const lifecycleOperations: readonly RepositoryLifecycleOperation[] = ['prepare', 'checkout', 'publish', 'cleanup'];

function workspace(branch = 'HEAD'): RepositoryWorkspace {
  return { id: workspaceRequest.workspaceId, ...prepareInput, snapshot: { commit: initialCommit, branch, dirty: false } };
}

function remoteLifecycle(operations = lifecycleOperations) {
  let snapshot = { commit: initialCommit, branch: 'afk/run-1', dirty: false };
  const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
    const operation = String(input).split('/').at(-1);
    const payload = operation === 'prepare' ? workspace()
      : operation === 'checkout' ? workspace('afk/run-1')
        : operation === 'snapshot' ? snapshot
          : operation === 'publish' ? { commit: snapshot.commit, branch: snapshot.branch, url: 'https://git.example/changes/1' }
            : { removed: true };
    return new Response(JSON.stringify(payload));
  });
  const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example/api', token: 'private-token', transport,
    lifecycle: { repositories: [prepareInput.repository], operations } });
  return { provider, transport, setSnapshot: (value: typeof snapshot) => { snapshot = value; } };
}

describe('configured repository lifecycle', () => {
  it('prepares, checks out, publishes a run branch without merging and removes only the owned session', async () => {
    const { provider, transport, setSnapshot } = remoteLifecycle();
    expect(provider.capabilities).toEqual({ read: true, clone: false, push: false, prepare: true, checkout: true, publish: true, cleanup: true });
    expect(await provider.prepare(prepareInput)).toEqual(workspace());
    const unsafeInput = { ...workspaceRequest, path: '/outside', repository: { url: 'https://outside.example' }, ref: 'main', force: true, merge: true };
    expect(await provider.checkout(unsafeInput)).toEqual(workspace('afk/run-1'));
    setSnapshot({ commit: publishedCommit, branch: 'afk/run-1', dirty: false });
    expect(await provider.publish(unsafeInput)).toEqual({ commit: publishedCommit, branch: 'afk/run-1', url: 'https://git.example/changes/1' });
    expect(await provider.cleanup(unsafeInput)).toEqual({ removed: true });
    const requests = transport.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }));
    expect(requests.map(request => request.url)).toEqual([
      'https://workspace.example/api/workspaces/repo/prepare',
      'https://workspace.example/api/workspaces/repo/sessions/workspace-1/checkout',
      'https://workspace.example/api/workspaces/repo/sessions/workspace-1/snapshot',
      'https://workspace.example/api/workspaces/repo/sessions/workspace-1/publish',
      'https://workspace.example/api/workspaces/repo/sessions/workspace-1/snapshot',
      'https://workspace.example/api/workspaces/repo/sessions/workspace-1/cleanup',
    ]);
    expect(requests[1].body).toEqual({ workspaceId: 'workspace-1', branch: 'afk/run-1' });
    expect(requests[3].body).toEqual({ workspaceId: 'workspace-1', expectedCommit: publishedCommit, expectedBranch: 'afk/run-1', merge: false });
    expect(requests[5].body).toEqual({ workspaceId: 'workspace-1', expectedCommit: publishedCommit, expectedBranch: 'afk/run-1' });
    expect(transport.mock.calls.every(([, init]) => init?.signal && init.redirect === 'error')).toBe(true);
    await expect(provider.cleanup(workspaceRequest)).rejects.toThrow(/unowned/);
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it('keeps lifecycle opt-in and rejects unsupported operations before IO', async () => {
    const { provider, transport } = remoteLifecycle(['prepare']);
    expect(provider.capabilities.checkout).toBe(false);
    await expect(provider.checkout(workspaceRequest)).rejects.toThrow(/does not support checkout/);
    const plain = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport });
    await expect(plain.prepare(prepareInput)).rejects.toThrow(/not configured/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects lifecycle capability declarations that cannot be invoked', () => {
    expect(() => remoteLifecycle(['cleanup'])).toThrow(/requires prepare/);
    expect(() => remoteLifecycle(['prepare', 'publish'])).toThrow(/requires checkout/);
  });

  it.each([
    { repository: { url: 'https://attacker.example', ref: 'main' }, runId: 'run-1' },
    { repository: { url: 'repo', ref: '--upload-pack=evil' }, runId: 'run-1' },
    { repository: { url: 'repo', ref: 'other' }, runId: 'run-1' },
    { ...prepareInput, runId: '../outside' },
    { ...prepareInput, runId: 'a\0b' },
  ])('rejects unconfigured or unsafe prepare input %j', async input => {
    const { provider, transport } = remoteLifecycle();
    await expect(provider.prepare(input)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['../outside', '/tmp/repo', '--execute', 'unknown'])('refuses unowned workspace %s before IO', async workspaceId => {
    const { provider, transport } = remoteLifecycle();
    await expect(provider.cleanup({ workspaceId })).rejects.toThrow();
    await expect(provider.publish({ workspaceId })).rejects.toThrow();
    await expect(provider.checkout({ workspaceId })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses dirty, unpublished, and changed-branch cleanup without issuing a delete', async () => {
    const { provider, transport, setSnapshot } = remoteLifecycle();
    await provider.prepare(prepareInput);
    await provider.checkout(workspaceRequest);
    setSnapshot({ commit: initialCommit, branch: 'afk/run-1', dirty: true });
    await expect(provider.cleanup(workspaceRequest)).rejects.toThrow(/dirty/);
    setSnapshot({ commit: publishedCommit, branch: 'afk/run-1', dirty: false });
    await expect(provider.cleanup(workspaceRequest)).rejects.toThrow(/unpublished/);
    setSnapshot({ commit: initialCommit, branch: 'main', dirty: false });
    await expect(provider.cleanup(workspaceRequest)).rejects.toThrow(/branch changed/);
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/cleanup'))).toHaveLength(0);
    setSnapshot({ commit: initialCommit, branch: 'afk/run-1', dirty: false });
    await expect(provider.cleanup(workspaceRequest)).resolves.toEqual({ removed: true });
  });

  it.each([
    null, [], {}, { ...workspace(), id: '../outside' }, { ...workspace(), runId: 'other' },
    { ...workspace(), repository: { url: 'other', ref: 'main' } },
    { ...workspace(), snapshot: { commit: 'not-a-commit', branch: 'HEAD', dirty: false } },
    { ...workspace(), snapshot: { commit: initialCommit, branch: 'HEAD', dirty: true } },
    { ...workspace(), path: '/tmp/arbitrary-runner-path' },
  ])('rejects malformed remote workspace response %j', async payload => {
    const { transport } = fakeTransport(payload);
    const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport,
      lifecycle: { repositories: [prepareInput.repository], operations: lifecycleOperations } });
    await expect(provider.prepare(prepareInput)).rejects.toThrow();
    await expect(provider.cleanup(workspaceRequest)).rejects.toThrow(/unowned/);
  });

  it.each([
    { commit: publishedCommit, branch: 'afk/run-1' },
    { commit: initialCommit, branch: 'main' },
    { commit: initialCommit, branch: 'afk/run-1', url: 'https://user:secret@git.example/changes/1' },
  ])('rejects invalid publication responses %j and retains unpublished work', async result => {
    const { provider, transport } = remoteLifecycle();
    await provider.prepare(prepareInput);
    await provider.checkout(workspaceRequest);
    transport.mockImplementationOnce(async () => new Response(JSON.stringify(workspace('afk/run-1').snapshot)));
    transport.mockImplementationOnce(async () => new Response(JSON.stringify(result)));
    await expect(provider.publish(workspaceRequest)).rejects.toThrow();
  });

  it('requires a run branch after checkout', async () => {
    const { provider, transport } = remoteLifecycle();
    await provider.prepare(prepareInput);
    transport.mockImplementationOnce(async () => new Response(JSON.stringify(workspace('main'))));
    await expect(provider.checkout(workspaceRequest)).rejects.toThrow(/run branch/);
    await expect(provider.publish(workspaceRequest)).rejects.toThrow(/checked out/);
  });

  it('rejects malformed cleanup responses and retains ownership for retry', async () => {
    const { provider, transport } = remoteLifecycle();
    await provider.prepare(prepareInput);
    await provider.checkout(workspaceRequest);
    transport.mockImplementationOnce(async () => new Response(JSON.stringify(workspace('afk/run-1').snapshot)));
    transport.mockImplementationOnce(async () => new Response('{"removed":"true"}'));
    await expect(provider.cleanup(workspaceRequest)).rejects.toThrow(/cleanup response/);
    await expect(provider.cleanup(workspaceRequest)).resolves.toEqual({ removed: true });
  });

  it('rejects duplicate preparation and concurrent workspace mutations', async () => {
    const { provider, transport } = remoteLifecycle();
    await provider.prepare(prepareInput);
    await expect(provider.prepare(prepareInput)).rejects.toThrow(/already prepared/);
    let resolve!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const pending = provider.checkout(workspaceRequest);
    await expect(provider.cleanup(workspaceRequest)).rejects.toThrow(/in progress/);
    resolve(new Response(JSON.stringify(workspace('afk/run-1'))));
    await pending;
  });

  it('supports cancellation before and during HTTP operations and redacts transport failures', async () => {
    const { provider, transport } = remoteLifecycle();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(provider.prepare(prepareInput, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(transport).not.toHaveBeenCalled();
    const next = new AbortController();
    transport.mockImplementationOnce(async () => { next.abort(new Error('interrupted')); return new Response('{}'); });
    await expect(provider.prepare(prepareInput, { signal: next.signal })).rejects.toThrow('interrupted');
    transport.mockRejectedValueOnce(new Error('private-token https://user:password@workspace.example'));
    await expect(provider.prepare(prepareInput)).rejects.toThrow('Provider HTTP transport failed');
    transport.mockImplementationOnce(async () => new Response('private-token', { status: 403 }));
    await expect(provider.prepare(prepareInput)).rejects.toThrow('Provider HTTP request failed (403)');
  });
});

describe('special git backend lifecycle', () => {
  it('uses fixed verbs and JSON stdin, binds configured repo/ref and never invokes a shell', async () => {
    const executor = vi.fn(async request => {
      const operation = request.args[0];
      const payload = operation === 'prepare' ? workspace()
        : operation === 'checkout' ? workspace('afk/run-1')
          : operation === 'snapshot' ? workspace('afk/run-1').snapshot
            : operation === 'publish' ? { commit: initialCommit, branch: 'afk/run-1' } : { removed: true };
      return { stdout: JSON.stringify(payload), stderr: '' };
    }) satisfies CommandExecutor;
    const provider = new SpecialGitBackendProvider({ backend: 'configured-backend', executor,
      lifecycle: { repositories: [prepareInput.repository], operations: lifecycleOperations } });
    await provider.prepare(prepareInput);
    await provider.checkout(workspaceRequest);
    await provider.publish(workspaceRequest);
    await provider.cleanup(workspaceRequest);
    expect(executor.mock.calls.map(([request]) => request.args)).toEqual([
      ['prepare', '--json'], ['checkout', '--json'], ['snapshot', '--json'], ['publish', '--json'], ['snapshot', '--json'], ['cleanup', '--json'],
    ]);
    expect(JSON.parse(executor.mock.calls[3][0].input!)).toEqual({ ...workspaceRequest,
      repository: prepareInput.repository, expectedCommit: initialCommit, expectedBranch: 'afk/run-1', merge: false });
    expect(executor.mock.calls.every(([request]) => request.command === 'configured-backend')).toBe(true);
  });

  it('redacts executor errors and rejects invalid JSON', async () => {
    const executor = vi.fn<Parameters<CommandExecutor>, ReturnType<CommandExecutor>>();
    const provider = new SpecialGitBackendProvider({ backend: 'configured-backend', executor,
      lifecycle: { repositories: [prepareInput.repository], operations: lifecycleOperations } });
    executor.mockRejectedValueOnce(new Error('backend failed with token=secret'));
    await expect(provider.prepare(prepareInput)).rejects.toThrow('special git backend lifecycle command failed');
    executor.mockResolvedValueOnce({ stdout: 'secret', stderr: '' });
    await expect(provider.prepare(prepareInput)).rejects.toThrow('special git backend returned invalid JSON');
  });
});

describe('managed local repository lifecycle', () => {
  it('captures immutable recovery ownership without retaining allocation aliases', () => {
    const allocation = { id: 'owned-id', repository: { url: 'repo', ref: 'main' }, runId: 'failed-run', path: '/owned/checkout' };
    const original = structuredClone(allocation);
    const failure = new Error('preparation failed');
    const cleanupFailure = new Error('cleanup failed');
    const error = new RepositoryPreparationCleanupError(allocation, failure, cleanupFailure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.name).toBe('RepositoryPreparationCleanupError');
    expect(error.cause).toBe(failure);
    expect(error.errors).toEqual([failure, cleanupFailure]);
    expect(error.allocation).toEqual(original);
    expect(Object.isFrozen(error.allocation)).toBe(true);
    expect(Object.isFrozen(error.allocation.repository)).toBe(true);
    allocation.id = 'foreign-id';
    allocation.repository.url = 'foreign-repo';
    allocation.repository.ref = 'other';
    allocation.runId = 'other-run';
    allocation.path = '/foreign/checkout';
    expect(error.allocation).toEqual(original);
    expect(Reflect.set(error, 'allocation', allocation)).toBe(false);
    expect(Reflect.deleteProperty(error, 'allocation')).toBe(false);
    expect(Reflect.set(error.allocation, 'path', '/foreign/checkout')).toBe(false);
    expect(Reflect.set(error.allocation.repository, 'url', 'foreign-repo')).toBe(false);
    expect(error.allocation).toEqual(original);
  });

  async function allocationFixture(executor: CommandExecutor = executeCommand, withoutRemoval = false) {
    const repo = await initRepo();
    const root = await tempDir('afk-managed-allocation-');
    const storeRoot = join(root, 'store');
    const bare = join(storeRoot, 'fixture.git');
    const workspaceRoot = join(root, 'workspaces');
    await fs.mkdir(storeRoot);
    await git(repo.path, ['clone', '--bare', '--no-hardlinks', repo.path, bare]);
    const store = new RepositoryStore(storeRoot);
    const paths: string[] = [];
    vi.spyOn(store, 'ensureCheckout').mockImplementation(async (_url, path) => {
      await git(bare, ['worktree', 'add', '--detach', path, repo.head]);
      paths.push(path);
      expect(await store.ownsCheckout(path)).toBe(true);
    });
    const leases = new RepositoryLeases(join(root, 'leases'));
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'repo', path: repo.path,
      remoteUrl: 'https://fixture.invalid/repo.git', baseBranch: repo.branch, leaseKey: 'gitlab:fixture.invalid/repo' }],
    git: executor, managed: { workspaceRoot, store: withoutRemoval ? { ensureCheckout: store.ensureCheckout.bind(store),
      ownsCheckout: store.ownsCheckout.bind(store), withCheckoutLock: store.withCheckoutLock.bind(store) } : store, leases } });
    return { provider, repo, root, bare, workspaceRoot, store, leases, paths };
  }

  it.each(['HEAD', '--abbrev-ref', '--porcelain'])('reclaims a real owned allocation after snapshot %s fails', async argument => {
    const failure = new Error('snapshot I/O failed after allocation');
    let failed = false;
    const executor: CommandExecutor = async request => {
      if (!failed && request.args.includes(argument)) {
        failed = true;
        throw failure;
      }
      return executeCommand(request);
    };
    const { provider, bare, workspaceRoot, paths, store } = await allocationFixture(executor);
    const sibling = join(await tempDir('afk-managed-sibling-'), 'checkout');
    await git(bare, ['worktree', 'add', '--detach', sibling, 'HEAD']);
    await expect(provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' })).rejects.toBe(failure);
    expect(paths).toHaveLength(1);
    await expect(fs.stat(paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(workspaceRoot)).toEqual([]);
    expect((await git(bare, ['worktree', 'list', '--porcelain'])).stdout).not.toContain(paths[0]);
    expect(await store.ownsCheckout(sibling)).toBe(true);
    expect(await fs.readFile(join(sibling, 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it('reclaims through the store even when every provider snapshot command fails', async () => {
    const failure = new Error('snapshot executor unavailable');
    const { provider, paths, bare } = await allocationFixture(async () => { throw failure; });
    await expect(provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' })).rejects.toBe(failure);
    await expect(fs.stat(paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await git(bare, ['worktree', 'list', '--porcelain'])).stdout).not.toContain(paths[0]);
  });

  it('reclaims with an existing store adapter that only exposes ownership and checkout locks', async () => {
    const failure = new Error('transient snapshot failure');
    let failed = false;
    const test = await allocationFixture(async request => {
      if (!failed) { failed = true; throw failure; }
      return executeCommand(request);
    }, true);
    await expect(test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' })).rejects.toBe(failure);
    await expect(fs.stat(test.paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await git(test.bare, ['worktree', 'list', '--porcelain'])).stdout).not.toContain(test.paths[0]);
  });

  it('reports allocation recovery when an adapter cannot inspect cleanliness during rollback', async () => {
    const failure = new Error('persistent snapshot failure');
    const test = await allocationFixture(async () => { throw failure; }, true);
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(RepositoryPreparationCleanupError);
    if (!(error instanceof RepositoryPreparationCleanupError)) throw new Error('Missing recoverable preparation error');
    expect(error.allocation).toEqual({ id: expect.any(String), repository: { url: 'repo', ref: test.repo.branch },
      runId: 'failed-run', path: test.paths[0] });
    expect(error.allocation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(error.cause).toBe(failure);
    expect(error.errors).toEqual([failure, failure]);
    expect(Object.isFrozen(error.allocation)).toBe(true);
    expect(Object.isFrozen(error.allocation.repository)).toBe(true);
    expect(await test.store.ownsCheckout(test.paths[0])).toBe(true);
    expect((await git(test.paths[0], ['status', '--porcelain'])).stdout).toBe('');
  });

  it('reclaims after snapshot validation fails and permits retrying the same run', async () => {
    let invalid = true;
    const { provider, paths } = await allocationFixture(async request => {
      if (invalid && request.args.join(' ') === 'rev-parse HEAD') return { stdout: 'invalid-commit', stderr: '' };
      return executeCommand(request);
    });
    const request = { repository: { url: 'repo' }, runId: 'failed-run' };
    await expect(provider.prepare(request)).rejects.toThrow('invalid repository lifecycle commit');
    await expect(fs.stat(paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
    invalid = false;
    const workspace = await provider.prepare(request);
    await expect(provider.cleanup({ workspaceId: workspace.id })).resolves.toEqual({ removed: true });
  });

  it.each(['allocation', 'snapshot', 'lease'])('reclaims after cancellation during %s without reusing the aborted signal', async stage => {
    const controller = new AbortController();
    const failure = new Error('cancelled after allocation');
    const test = await allocationFixture(async request => {
      const result = await executeCommand(request);
      if (stage === 'snapshot' && request.args[0] === 'status') controller.abort(failure);
      return result;
    });
    if (stage === 'allocation') {
      const allocate = vi.mocked(test.store.ensureCheckout).getMockImplementation()!;
      vi.spyOn(test.store, 'ensureCheckout').mockImplementation(async (...args) => {
        await allocate(...args);
        controller.abort(failure);
      });
    }
    if (stage === 'lease') {
      const run = test.leases.run.bind(test.leases);
      vi.spyOn(test.leases, 'run').mockImplementation(async (keys, operation) => {
        const result = await run(keys, operation);
        controller.abort(failure);
        return result;
      });
    }
    await expect(test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }, { signal: controller.signal })).rejects.toBe(failure);
    await expect(fs.stat(test.paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims an allocation when the lease fails after the callback returns', async () => {
    const test = await allocationFixture();
    const failure = new Error('lease heartbeat failed');
    const run = test.leases.run.bind(test.leases);
    vi.spyOn(test.leases, 'run').mockImplementationOnce(async (keys, operation) => {
      await run(keys, operation);
      throw failure;
    });
    await expect(test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' })).rejects.toBe(failure);
    await expect(fs.stat(test.paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports recovery if the allocation disappears before rollback', async () => {
    const failure = new Error('snapshot failed after allocation moved');
    const test = await allocationFixture(async request => {
      await fs.rename(request.cwd!, `${request.cwd}-moved`);
      throw failure;
    });
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ allocation: { path: test.paths[0] }, errors: [failure, expect.any(Error)] });
    expect(await fs.readFile(join(`${test.paths[0]}-moved`, 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it('preserves snapshot and lease release errors together', async () => {
    const failure = new Error('snapshot failed');
    const releaseFailure = new Error('lease release failed');
    const test = await allocationFixture(async () => { throw failure; });
    const acquire = test.leases.acquire.bind(test.leases);
    vi.spyOn(test.leases, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args);
      return { ...lease, release: async () => { await lease.release(); throw releaseFailure; } };
    });
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ errors: [failure, releaseFailure] });
    await expect(fs.stat(test.paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a replacement introduced before the post-allocation identity read', async () => {
    const test = await allocationFixture(async () => { throw new Error('snapshot failed'); });
    const allocate = vi.mocked(test.store.ensureCheckout).getMockImplementation()!;
    vi.spyOn(test.store, 'ensureCheckout').mockImplementation(async (...args) => {
      await allocate(...args);
      await git(test.bare, ['worktree', 'move', args[1], `${args[1]}-original`]);
      await git(test.bare, ['worktree', 'add', '--detach', args[1], test.repo.head]);
    });
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ allocation: { path: test.paths[0] } });
    expect(await fs.readFile(join(test.paths[0], 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(await fs.readFile(join(`${test.paths[0]}-original`, 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it.each(['tracked', 'untracked', 'ignored'])('retains %s content after failed preparation and exposes recoverable allocation', async content => {
    const failure = new Error('snapshot failed after a concurrent write');
    let changed = false;
    const test = await allocationFixture(async request => {
      if (!changed) {
        changed = true;
        if (content === 'ignored') {
          await git(request.cwd!, ['config', 'core.excludesFile', join(request.cwd!, '.gitignore')]);
          await fs.writeFile(join(request.cwd!, '.gitignore'), '*\n');
        }
        await fs.writeFile(join(request.cwd!, content === 'tracked' ? 'README.md' : 'keep.txt'), 'keep work\n');
        throw failure;
      }
      return executeCommand(request);
    });
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ allocation: { id: expect.any(String), path: test.paths[0], repository: { url: 'repo' }, runId: 'failed-run' },
      errors: [failure, expect.any(Error)], cause: failure });
    expect((error as Error).message).toContain(test.paths[0]);
    expect(await fs.readFile(join(test.paths[0], content === 'tracked' ? 'README.md' : 'keep.txt'), 'utf8')).toBe('keep work\n');
    expect((await git(test.bare, ['worktree', 'list', '--porcelain'])).stdout).toContain(test.paths[0]);
  });

  it.each(['ownership', 'lock', 'remove'])('retains the allocation and both errors when %s prevents rollback', async stage => {
    const failure = new Error('snapshot failed');
    const cleanupFailure = new Error(`${stage} failed`);
    const test = await allocationFixture(async () => { throw failure; });
    if (stage === 'ownership') vi.spyOn(test.store, 'ownsCheckout').mockResolvedValueOnce(true).mockResolvedValue(false);
    if (stage === 'lock') {
      vi.spyOn(test.leases, 'run').mockImplementationOnce(async (_keys, operation) => operation())
        .mockRejectedValueOnce(cleanupFailure);
    }
    if (stage === 'remove') vi.spyOn(test.store, 'removeCheckout').mockRejectedValue(cleanupFailure);
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ allocation: { path: test.paths[0] }, errors: [failure, expect.any(Error)] });
    if (stage !== 'ownership') expect((error as AggregateError).errors[1]).toBe(cleanupFailure);
    expect(await fs.readFile(join(test.paths[0], 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it('retains a replacement from another store even when the path is reused', async () => {
    const failure = new Error('snapshot failed after path replacement');
    const foreign = await initRepo();
    let replaced = false;
    const test = await allocationFixture(async request => {
      if (!replaced) {
        replaced = true;
        await fs.rename(request.cwd!, `${request.cwd}-original`);
        await git(foreign.path, ['worktree', 'add', '--detach', request.cwd!, foreign.head]);
        throw failure;
      }
      return executeCommand(request);
    });
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ allocation: { path: test.paths[0] }, errors: [failure, expect.any(Error)] });
    expect(await test.store.ownsCheckout(test.paths[0])).toBe(false);
    expect(await fs.readFile(join(test.paths[0], 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(await fs.readFile(join(`${test.paths[0]}-original`, 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it('retains a nested worktree after preparation fails', async () => {
    const failure = new Error('snapshot failed with a nested worktree');
    const test = await allocationFixture(async request => {
      await git(request.cwd!, ['worktree', 'add', '--detach', join(request.cwd!, 'nested'), 'HEAD']);
      throw failure;
    });
    const error: unknown = await test.provider.prepare({ repository: { url: 'repo' }, runId: 'failed-run' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ allocation: { path: test.paths[0] }, errors: [failure, expect.any(Error)] });
    expect((error as AggregateError).errors[1].message).toContain('nested worktree');
    expect(await fs.readFile(join(test.paths[0], 'nested', 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  async function managedProvider(realLeases = false) {
    const repo = await initRepo();
    const root = await tempDir('afk-managed-');
    const owned = new Set<string>();
    const store = {
      ensureCheckout: vi.fn(async (_url: string, path: string, base: string) => {
        await git(repo.path, ['worktree', 'add', '--detach', path, base]);
        owned.add(path);
      }),
      ownsCheckout: vi.fn(async (path: string) => owned.has(path)),
      withCheckoutLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) => operation()),
    };
    const leaseRoot = join(root, '.leases');
    const leases = realLeases ? new RepositoryLeases(leaseRoot)
      : { run: vi.fn(async (_keys: readonly string[], operation: () => Promise<unknown>) => operation()) };
    const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
    const executor: CommandExecutor = async request => {
      calls.push(request);
      if (request.args.includes('push')) return { stdout: '', stderr: '' };
      return executeCommand(request);
    };
    await git(repo.path, ['remote', 'add', 'origin', 'https://git.example/repo.git']);
    const provider = new MultiRepositoryProvider({ repositories: [{ name: 'repo', path: repo.path,
      remoteUrl: 'https://git.example/repo.git', baseBranch: repo.branch, leaseKey: 'gitlab:git.example/repo' }], git: executor,
    managed: { workspaceRoot: root, store: store as NonNullable<NonNullable<ConstructorParameters<typeof MultiRepositoryProvider>[0]['managed']>['store']>,
      leases: leases as NonNullable<NonNullable<ConstructorParameters<typeof MultiRepositoryProvider>[0]['managed']>['leases']> } });
    return { provider, repo, root, store, leases, calls, owned, leaseRoot };
  }

  it('uses the repository store, leases, a run branch, non-force push and non-force worktree cleanup', async () => {
    const { provider, repo, store, leases, calls } = await managedProvider();
    const prepared = await provider.prepare({ repository: { url: 'repo' }, runId: 'run-1' });
    expect(prepared.path).toBeTruthy();
    expect(prepared.snapshot.commit).toBe(repo.head);
    expect(store.ensureCheckout).toHaveBeenCalledWith('https://git.example/repo.git', prepared.path, repo.branch);
    const request = { workspaceId: prepared.id };
    expect((await provider.checkout(request)).snapshot.branch).toBe('afk/run-1');
    await provider.publish(request);
    await expect(provider.cleanup(request)).resolves.toEqual({ removed: true });
    await expect(fs.stat(prepared.path!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(provider.capabilities.clone).toBe(true);
    expect(provider.capabilities.push).toBe(true);
    expect(leases.run).toHaveBeenCalledWith(['gitlab:git.example/repo'], expect.any(Function));
    expect(store.withCheckoutLock).toHaveBeenCalled();
    expect(calls.find(call => call.args.includes('push'))?.args).toEqual([
      '-c', 'http.followRedirects=false', 'push', '--no-follow-tags', '--recurse-submodules=no', '--',
      'https://git.example/repo.git', `${repo.head}:refs/heads/afk/run-1`,
    ]);
    expect(calls.find(call => call.args[0] === 'worktree' && call.args[1] === 'remove')?.args).toEqual(['worktree', 'remove', prepared.path]);
  });

  it('retains dirty, ignored, unowned, and unpublished local work', async () => {
    const { provider, store, owned } = await managedProvider();
    const prepared = await provider.prepare({ repository: { url: 'repo' }, runId: 'run-1' });
    const request = { workspaceId: prepared.id };
    await provider.checkout(request);
    await fs.writeFile(join(prepared.path!, 'work.txt'), 'keep me');
    await expect(provider.cleanup(request)).rejects.toThrow(/dirty/);
    await fs.rm(join(prepared.path!, 'work.txt'));
    await fs.writeFile(join(prepared.path!, '.gitignore'), 'ignored\n');
    await git(prepared.path!, ['add', '.gitignore']);
    await git(prepared.path!, ['commit', '-m', 'unpublished']);
    await fs.writeFile(join(prepared.path!, 'ignored'), 'keep ignored work');
    await expect(provider.cleanup(request)).rejects.toThrow(/dirty/);
    await fs.rm(join(prepared.path!, 'ignored'));
    await expect(provider.cleanup(request)).rejects.toThrow(/unpublished/);
    owned.clear();
    await expect(provider.cleanup(request)).rejects.toThrow(/unowned/);
    expect(store.ownsCheckout).toHaveBeenCalled();
    expect(await fs.readFile(join(prepared.path!, '.gitignore'), 'utf8')).toBe('ignored\n');
  });

  it('refuses publication after origin changes and cleanup after path replacement', async () => {
    const { provider, calls } = await managedProvider();
    const prepared = await provider.prepare({ repository: { url: 'repo' }, runId: 'run-1' });
    const request = { workspaceId: prepared.id };
    await provider.checkout(request);
    await git(prepared.path!, ['remote', 'set-url', 'origin', 'https://elsewhere.example/repo.git']);
    await expect(provider.publish(request)).rejects.toThrow(/origin changed/);
    expect(calls.some(call => call.args.includes('push'))).toBe(false);
    const moved = `${prepared.path}-saved`;
    await fs.rename(prepared.path!, moved);
    await fs.symlink(moved, prepared.path!, 'dir');
    await expect(provider.cleanup(request)).rejects.toThrow(/relocated/);
    expect(await fs.readFile(join(moved, 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it.each([
    ['https://unapproved.example/repo.git'],
    ['https://git.example/repo.git', 'https://unapproved.example/repo.git'],
    ['https://git.example/repo.git', 'https://git.example/repo.git'],
  ])('rejects unapproved or multiple effective push URLs %j', async (...pushUrls) => {
    const { provider, calls } = await managedProvider();
    const prepared = await provider.prepare({ repository: { url: 'repo' }, runId: 'run-1' });
    const request = { workspaceId: prepared.id };
    await provider.checkout(request);
    for (const url of pushUrls) await git(prepared.path!, ['remote', 'set-url', '--add', '--push', 'origin', url]);
    await expect(provider.publish(request)).rejects.toThrow(/push destination changed/);
    expect(calls.some(call => call.args.includes('push'))).toBe(false);
  });

  it.each(['insteadOf', 'pushInsteadOf'])('rejects applicable %s URL rewrites even with an approved explicit pushurl', async rewrite => {
    const { provider, calls } = await managedProvider();
    const prepared = await provider.prepare({ repository: { url: 'repo' }, runId: 'run-1' });
    const request = { workspaceId: prepared.id };
    await provider.checkout(request);
    await git(prepared.path!, ['remote', 'set-url', '--push', 'origin', 'https://git.example/repo.git']);
    await git(prepared.path!, ['config', `url.https://unapproved.example/.${rewrite}`, 'https://git.example/']);
    await expect(provider.publish(request)).rejects.toThrow(/URL rewrite/);
    expect(calls.some(call => call.args.includes('push'))).toBe(false);
  });

  it('rejects a rewritten raw origin even if its effective URL matches the approved destination', async () => {
    const { provider, calls } = await managedProvider();
    const prepared = await provider.prepare({ repository: { url: 'repo' }, runId: 'run-1' });
    const request = { workspaceId: prepared.id };
    await provider.checkout(request);
    await git(prepared.path!, ['remote', 'set-url', 'origin', 'unapproved:repo.git']);
    await git(prepared.path!, ['config', 'url.https://git.example/.insteadOf', 'unapproved:']);
    expect((await git(prepared.path!, ['remote', 'get-url', 'origin'])).stdout.trim()).toBe('https://git.example/repo.git');
    await expect(provider.publish(request)).rejects.toThrow(/origin changed/);
    expect(calls.some(call => call.args.includes('push'))).toBe(false);
  });

  it('holds the real repository lease across execution and cleanup while nested operations reenter', async () => {
    const { provider, leaseRoot } = await managedProvider(true);
    const competitor = new RepositoryLeases(leaseRoot);
    const keys = ['gitlab:git.example/repo'];
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const pending = new RepositoryLifecycleService(provider).run({ repository: { url: 'repo' }, runId: 'run-1' }, async () => {
      enter();
      await gate;
      return 'ok';
    });
    await entered;
    try {
      await expect(competitor.acquire(keys)).rejects.toThrow(/leased by another execution/);
    } finally { resume(); }
    await expect(pending).resolves.toMatchObject({ value: 'ok', cleanup: { removed: true } });
    const available = await competitor.acquire(keys);
    await available.release();
  });
});
