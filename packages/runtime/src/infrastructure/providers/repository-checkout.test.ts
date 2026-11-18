import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiRepositoryProvider, RemoteWorkspaceProvider, SpecialGitBackendProvider } from './repositories.js';
import { executeCommand, type CommandRequest } from './dependencies.js';
import type { RepositoryProvider, RepositoryWorkspace } from '../../plugin-sdk/capabilities.js';
import { RepositoryLifecycleService } from '../../application/plugins/repository-lifecycle.js';
import { invokeCapability } from '../../application/plugins/operations.js';
import { PluginRuntime } from '../../application/plugins/runtime.js';

const baseCommit = 'a'.repeat(40);
const sourceCommit = 'b'.repeat(40);
const remoteUrl = 'https://git.example/repo.git';
const prepare = { repository: { url: 'repo', ref: 'main' }, runId: 'run-branch' };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function local() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-checkout-')));
  roots.push(root);
  const seed = join(root, 'seed');
  const seedGit = (...args: string[]) => executeCommand({ command: 'git', cwd: root, args: ['-c', 'core.hooksPath=/dev/null', ...args] });
  await seedGit('init', '--template=', '-b', 'main', seed);
  await seedGit('-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'fixture');
  const state = { commit: baseCommit, branch: 'HEAD', sourceCommit, dirty: false, failFetch: false, existingCommit: '' };
  const git = vi.fn(async (request: CommandRequest) => {
    const args = [...request.args];
    let stdout = '';
    if (args[0] === 'rev-parse') stdout = args.includes('--abbrev-ref') ? state.branch : args.includes('--verify') ? state.sourceCommit : state.commit;
    else if (args[0] === 'status') stdout = state.dirty ? ' M file' : '';
    else if (args[0] === 'config') stdout = `remote.origin.url\n${remoteUrl}\0`;
    else if (args[0] === 'remote') stdout = remoteUrl + '\n';
    else if (args.includes('fetch') && state.failFetch) throw new Error('fetch refused');
    else if (args[0] === 'for-each-ref') stdout = state.existingCommit;
    else if (args[0] === 'switch') {
      if (args[1] === '-c' && state.existingCommit) throw new Error('branch already exists');
      state.branch = args[1] === '-c' ? args[2] : args[1];
      state.commit = args[1] === '-c' ? args[3] ?? state.commit : state.existingCommit;
    }
    return { stdout, stderr: '' };
  });
  const store = {
    ensureCheckout: vi.fn(async (_url: string, path: string, base: string) => { await seedGit('-C', seed, 'worktree', 'add', '--detach', path, base); }),
    ownsCheckout: vi.fn(async () => true),
    withCheckoutLock: async <Result>(_path: string, action: () => Promise<Result>) => action(),
  };
  const leases = { run: async <Result>(_keys: string[], action: () => Promise<Result>) => action() };
  const provider = new MultiRepositoryProvider({ repositories: [{ name: 'repo', path: root, remoteUrl, baseBranch: 'main', leaseKey: 'github:fixture/repo' }],
    git, managed: { workspaceRoot: root, store, leases } });
  const workspace = await provider.prepare(prepare);
  return { provider, workspace, state, git, store };
}

function remote() {
  const workspace: RepositoryWorkspace = { ...prepare, id: 'workspace', snapshot: { commit: baseCommit, branch: 'HEAD', dirty: false } };
  const state = { commit: baseCommit, branch: 'HEAD', wrongCommit: false };
  const transport = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const operation = String(url).split('/').at(-1);
    const input = options?.body ? JSON.parse(String(options.body)) as { branch?: string; ref?: string } : {};
    let result: unknown = workspace;
    if (operation === 'checkout') {
      state.branch = input.branch ?? 'missing';
      state.commit = input.ref || state.wrongCommit ? sourceCommit : baseCommit;
      result = { ...workspace, snapshot: { ...state, dirty: false } };
    } else if (operation === 'snapshot') result = { ...state, dirty: false };
    else if (operation === 'cleanup') result = { removed: true };
    else if (operation === 'publish') result = { commit: state.commit, branch: state.branch };
    return new Response(JSON.stringify(result));
  });
  const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport,
    lifecycle: { repositories: [prepare.repository], operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
  return { provider, transport, state };
}

describe('Repository requested checkout branch and source', () => {
  it.each(['checkout', 'snapshot'])('interrupts a cooperative special-backend %s at its deadline', async phase => {
    const workspace: RepositoryWorkspace = { ...prepare, id: 'special-owned', snapshot: { commit: baseCommit, branch: 'HEAD', dirty: false } };
    let received: CommandRequest | undefined;
    const executor = vi.fn(async (request: CommandRequest) => {
      const operation = request.args[0];
      if (operation === 'prepare') return { stdout: JSON.stringify(workspace), stderr: '' };
      if (operation !== phase) return { stdout: JSON.stringify(operation === 'cleanup' ? { removed: true } : workspace.snapshot), stderr: '' };
      received = request;
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const timer = setTimeout(() => { request.signal?.removeEventListener('abort', abort); resolve({ stdout: JSON.stringify(workspace.snapshot), stderr: '' }); }, 150);
        const abort = () => { clearTimeout(timer); reject(new Error('special deadline')); };
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) abort();
      });
    });
    const provider = new SpecialGitBackendProvider({ backend: 'inert-backend', executor,
      lifecycle: { repositories: [prepare.repository], operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
    await provider.prepare(prepare);
    const caller = new AbortController();
    const deadlineAt = Date.now() + 60;
    const options = { signal: caller.signal, deadlineAt };
    const operation = phase === 'checkout' ? provider.checkout({ workspaceId: workspace.id, branch: 'feat/task-qa', ref: 'feat/task' }, options)
      : provider.snapshot({ url: 'repo' }, options);
    await expect(operation).rejects.toThrow(/deadline/);
    expect(received?.deadlineAt).toBe(deadlineAt);
    expect(received?.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    if (phase === 'checkout') expect(await provider.cleanup({ workspaceId: workspace.id })).toEqual({ removed: true });
  });

  it('creates and publishes the requested implementation branch from the prepared revision', async () => {
    const f = await local();
    expect(await f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task' })).toMatchObject({ snapshot: { branch: 'feat/task', commit: baseCommit } });
    expect(f.git.mock.calls.map(([request]) => request.args)).toContainEqual(['switch', '-c', 'feat/task', baseCommit]);
    expect(await f.provider.publish({ workspaceId: f.workspace.id })).toEqual({ branch: 'feat/task', commit: baseCommit });
    expect(f.git.mock.calls.some(([request]) => request.args.includes(`${baseCommit}:refs/heads/feat/task`))).toBe(true);
  });

  it('pins a QA source from the configured remote before creating an independent QA branch', async () => {
    const f = await local();
    const caller = new AbortController();
    expect(await f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task-qa', ref: 'feat/task' }, { signal: caller.signal }))
      .toMatchObject({ repository: prepare.repository, snapshot: { branch: 'feat/task-qa', commit: sourceCommit } });
    const calls = f.git.mock.calls.map(([request]) => request);
    expect(calls.map(request => request.args)).toContainEqual(['-c', 'http.followRedirects=false', 'fetch', '--no-tags', '--no-recurse-submodules', '--', remoteUrl, 'refs/heads/feat/task']);
    expect(calls.map(request => request.args)).toContainEqual(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    expect(calls.map(request => request.args)).toContainEqual(['switch', '-c', 'feat/task-qa', sourceCommit]);
    expect(calls.filter(request => request.args.includes('fetch')).every(request => request.signal === caller.signal)).toBe(true);
    expect(await f.provider.cleanup({ workspaceId: f.workspace.id })).toEqual({ removed: true });
  });

  it('keeps the legacy checkout branch when omitted', async () => {
    const f = await local();
    expect(await f.provider.checkout({ workspaceId: f.workspace.id })).toMatchObject({ snapshot: { branch: 'afk/run-branch', commit: baseCommit } });
  });

  it('reuses an existing target only at the requested pinned revision', async () => {
    const f = await local();
    f.state.existingCommit = baseCommit;
    expect(await f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task' })).toMatchObject({ snapshot: { branch: 'feat/task', commit: baseCommit } });
    expect(f.git.mock.calls.map(([request]) => request.args)).toContainEqual(['switch', 'feat/task']);
    expect(f.git.mock.calls.some(([request]) => request.args.includes('-c') && request.args[0] === 'switch')).toBe(false);
  });

  it('refuses an existing target with a different revision without reset or switch', async () => {
    const f = await local();
    f.state.existingCommit = sourceCommit;
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task' })).rejects.toThrow(/revision/);
    expect(f.git.mock.calls.some(([request]) => ['switch', 'reset', 'branch'].includes(request.args[0]))).toBe(false);
  });

  it.each(['../outside', '--detach', 'feat//task', 'feat/task.lock', 'feat/task\nother'])('rejects invalid branch/source %j before commands', async value => {
    const f = await local();
    f.git.mockClear();
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: value })).rejects.toThrow(/ref/);
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task', ref: value })).rejects.toThrow(/ref/);
    expect(f.git).not.toHaveBeenCalled();
  });

  it('does not create or publish a branch after source acquisition fails', async () => {
    const f = await local();
    f.state.failFetch = true;
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task-qa', ref: 'feat/task' })).rejects.toThrow('fetch refused');
    expect(f.git.mock.calls.some(([request]) => request.args[0] === 'switch')).toBe(false);
    await expect(f.provider.publish({ workspaceId: f.workspace.id })).rejects.toThrow(/checked out/);
    expect(await f.provider.cleanup({ workspaceId: f.workspace.id })).toEqual({ removed: true });
  });

  it('rejects a malformed fetched revision before switch', async () => {
    const f = await local();
    f.state.sourceCommit = 'not-a-commit';
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task-qa', ref: 'feat/task' })).rejects.toThrow(/commit|revision/);
    expect(f.git.mock.calls.some(([request]) => request.args[0] === 'switch')).toBe(false);
  });

  it.each(['dirty', 'commit', 'branch'])('refuses %s drift before fetching or creating the requested branch', async drift => {
    const f = await local();
    if (drift === 'dirty') f.state.dirty = true;
    if (drift === 'commit') f.state.commit = sourceCommit;
    if (drift === 'branch') f.state.branch = 'feat/other';
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task-qa', ref: 'feat/task' })).rejects.toThrow(/changed/);
    expect(f.git.mock.calls.some(([request]) => request.args.includes('fetch') || request.args[0] === 'switch')).toBe(false);
  });

  it('preserves the configured prepare allowlist when an explicit source is supported', async () => {
    const f = await local();
    f.git.mockClear();
    await expect(f.provider.prepare({ repository: { url: 'repo', ref: 'feat/task' }, runId: 'another-run' })).rejects.toThrow(/not configured/);
    expect(f.git).not.toHaveBeenCalled();
  });

  it('refuses the configured base branch as a publication target before IO', async () => {
    const f = await local();
    f.git.mockClear();
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: 'main' })).rejects.toThrow(/base branch/);
    expect(f.git).not.toHaveBeenCalled();
  });

  it('applies the absolute deadline to a cooperative source acquisition', async () => {
    const f = await local();
    const execute = f.git.getMockImplementation()!;
    f.git.mockImplementation(async request => {
      if (!request.args.includes('fetch')) return execute(request);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { request.signal?.removeEventListener('abort', abort); resolve({ stdout: '', stderr: '' }); }, 150);
        const abort = () => { clearTimeout(timer); reject(new Error('fetch deadline')); };
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) abort();
      });
    });
    await expect(f.provider.checkout({ workspaceId: f.workspace.id, branch: 'feat/task-qa', ref: 'feat/task' }, { deadlineAt: Date.now() + 60 })).rejects.toThrow(/deadline/);
    expect(f.git.mock.calls.find(([request]) => request.args.includes('fetch'))?.[0].signal?.aborted).toBe(true);
    expect(f.git.mock.calls.some(([request]) => request.args[0] === 'switch')).toBe(false);
  });

  it('forwards explicit remote checkout fields and updates the unchanged-cleanup baseline', async () => {
    const f = remote();
    await f.provider.prepare(prepare);
    expect(await f.provider.checkout({ workspaceId: 'workspace', branch: 'feat/task-qa', ref: 'feat/task' })).toMatchObject({ snapshot: { branch: 'feat/task-qa', commit: sourceCommit } });
    expect(JSON.parse(String(f.transport.mock.calls[1][1]?.body))).toEqual({ workspaceId: 'workspace', branch: 'feat/task-qa', ref: 'feat/task' });
    expect(await f.provider.cleanup({ workspaceId: 'workspace' })).toEqual({ removed: true });
  });

  it('rejects an unexpected checkout revision without an explicit source', async () => {
    const f = remote();
    await f.provider.prepare(prepare);
    f.state.wrongCommit = true;
    await expect(f.provider.checkout({ workspaceId: 'workspace', branch: 'feat/task' })).rejects.toThrow(/revision/);
    await expect(f.provider.publish({ workspaceId: 'workspace' })).rejects.toThrow(/checked out/);
  });

  it('retains unpublished changes after a source-based checkout', async () => {
    const f = remote();
    await f.provider.prepare(prepare);
    await f.provider.checkout({ workspaceId: 'workspace', branch: 'feat/task-qa', ref: 'feat/task' });
    f.state.commit = 'c'.repeat(40);
    await expect(f.provider.cleanup({ workspaceId: 'workspace' })).rejects.toThrow(/unpublished/);
    expect(f.transport.mock.calls.some(([url]) => String(url).endsWith('/cleanup'))).toBe(false);
  });

  it('preserves checkout options through the composite lifecycle and dispatcher', async () => {
    const runtime = new PluginRuntime();
    const workspace: RepositoryWorkspace = { ...prepare, id: 'workspace', snapshot: { commit: sourceCommit, branch: 'feat/task-qa', dirty: false } };
    const checkout = vi.fn(async () => workspace);
    const provider: RepositoryProvider = { id: 'fixture', capabilities: { read: true, clone: true, push: true, prepare: true, checkout: true, publish: true, cleanup: true },
      snapshot: async () => workspace.snapshot, prepare: async () => workspace, checkout,
      publish: async () => ({ commit: sourceCommit, branch: 'feat/task-qa' }), cleanup: async () => ({ removed: true }) };
    await runtime.activate({ id: 'fixture.repository-checkout', version: '1.0.0', setup(context) {
      context.registerRepositoryProvider('fixture', provider);
      context.registerSystemAction('fixture.inspect', async () => 'checked');
    } });
    try {
      const plan = { branch: 'feat/task-qa', ref: 'feat/task' };
      await new RepositoryLifecycleService(provider).run({ ...prepare, checkout: { ...plan, ...{ workspaceId: 'other-owned-handle' } } }, async () => 'checked');
      expect(checkout).toHaveBeenLastCalledWith({ workspaceId: 'workspace', ...plan }, undefined);
      await invokeCapability(runtime, { capability: 'repository.provider', provider: 'fixture', operation: 'run', input: { ...prepare, checkout: plan, action: 'fixture.inspect', input: {} } });
      expect(checkout).toHaveBeenLastCalledWith({ workspaceId: 'workspace', ...plan }, undefined);
      await invokeCapability(runtime, { capability: 'repository.provider', provider: 'fixture', operation: 'checkout', input: { workspaceId: 'workspace', ...plan } });
      expect(checkout).toHaveBeenLastCalledWith({ workspaceId: 'workspace', ...plan });
      await expect(invokeCapability(runtime, { capability: 'repository.provider', provider: 'fixture', operation: 'publish', input: { workspaceId: 'workspace', branch: 'feat/task-qa' } })).rejects.toThrow();
    } finally { await runtime.dispose(); }
  });
});
