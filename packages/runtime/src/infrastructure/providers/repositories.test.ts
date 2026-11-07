import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryProvider, RepositoryCapability } from '../../plugin-sdk/capabilities.js';
import {
  MultiRepositoryProvider,
  RemoteWorkspaceProvider,
  SpecialGitBackendProvider,
} from './repositories.js';
import { executeCommand, type CommandExecutor, type CommandResult, type FetchTransport } from './dependencies.js';

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
});
