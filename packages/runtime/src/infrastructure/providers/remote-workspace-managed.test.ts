import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteWorkspaceProvider } from './repositories.js';

const request = { runId: 'synthetic', repository: { url: 'api', ref: 'main' } };
const origin = 'https://git.example/team/api.git';
let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'afk-mounted-')));
  vi.stubEnv('AFK_STATE_DIR', join(root, 'state'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function provider(gitDirectory: string, transport: typeof fetch) {
  return new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport,
    lifecycle: { repositories: [request.repository], operations: ['prepare', 'checkout', 'publish', 'cleanup'] },
    managed: { workspaceRoot: root, repositories: [{ name: 'api', gitDirectory, remoteUrl: origin, leaseKey: 'gitlab:git.example/team/api' }] } });
}

it('holds an exclusive canonical lease until release and rejects operations outside the callback', async () => {
  const transport = vi.fn(async () => { throw new Error('Unexpected workspace request'); });
  const first = provider(root, transport);
  const second = provider(root, transport);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const active = first.withLifecycleLease!(request, async () => { enter(); await hold; });
  try {
    await entered;
    await expect(first.prepare(request)).rejects.toThrow('active repository lease');
    await expect(second.withLifecycleLease!({ ...request, runId: 'another' }, async () => true)).rejects.toThrow('leased by another execution');
  } finally { release(); await active; }
  await expect(second.withLifecycleLease!(request, async () => true)).resolves.toBe(true);
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ['other repository', 'belongs to another repository'], ['reported path', 'conflicts with trusted mount'],
  ['reported revision', 'differs from mounted checkout'], ['push destination', 'push destination changed'],
] as const)('refuses a prepared checkout with a mismatched %s', async (scenario, error) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main', 'seed');
  git('-C', 'seed', '-c', 'user.name=Fixture', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'seed');
  git('-C', 'seed', 'remote', 'add', 'origin', origin);
  const commit = git('-C', 'seed', 'rev-parse', 'HEAD');
  git('-C', 'seed', 'update-ref', 'refs/remotes/origin/main', commit);
  const mounted = provider(scenario === 'other repository' ? root : join(root, 'seed', '.git'), async () => {
    const checkout = join(root, 'api@synthetic');
    git('-C', 'seed', 'worktree', 'add', '--detach', checkout, commit);
    if (scenario === 'push destination') git('-C', 'seed', 'remote', 'set-url', '--push', 'origin', 'https://git.example/other.git');
    return Response.json({ ...request, id: 'session', ...(scenario === 'reported path' && { path: root }),
      snapshot: { branch: 'HEAD', dirty: false, commit: scenario === 'reported revision' ? '0'.repeat(40) : commit } });
  });
  await expect(mounted.withLifecycleLease!(request, () => mounted.prepare(request))).rejects.toThrow(error);
});
