import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveE2eRuntime } from './installed-runtime.js';

const entry = process.env.AFK_E2E_CLI_ENTRY;
const exec = promisify(execFile);
afterEach(() => { vi.unstubAllEnvs(); });

it.skipIf(!entry).each(['--cleanup', '--fix'])('protects an expired execution claim through installed doctor %s', async option => {
  const installation = resolveE2eRuntime(entry);
  if (installation.mode !== 'installed') throw new Error('An installed CLI is required');
  const runtimeModule = (path: string) => pathToFileURL(join(installation.runtime, path)).href;
  const { executionManifestPath, executionWorkspacePath, resolveWorkspaceRoot, workspaceDataDirectory } =
    await import(runtimeModule('infrastructure/workspace.js'));
  const { executionOwnershipKeys } = await import(runtimeModule('infrastructure/runtime/workspace-ownership.js'));
  const { FilesystemClaimLock } = await import(runtimeModule('domain/backlog/claim.js'));
  const { TaskRuntimeStore } = await import(runtimeModule('application/runtime/task-runtime.js'));
  const root = resolveWorkspaceRoot();
  const id = option === '--cleanup' ? '101' : '102';
  const projectKey = `doctor-install/reclamation-${id}`;
  const workItemId = `github:${projectKey}#${id}`;
  const workspace = executionWorkspacePath(workItemId);
  const checkoutPath = 'repositories/reclamation';
  const checkout = join(workspace, checkoutPath);
  const bare = join(root, 'repos', 'github.com', projectKey, 'bare.git');
  const seed = join(root, '..', `doctor-seed-${id}`);
  vi.stubEnv('AFK_STATE_DIR', join(root, '..', `doctor-state-${id}`));
  const repository = { platform: 'github', projectKey, name: 'reclamation', checkoutPath,
    baseBranch: 'main', workingBranch: `work/${id}`, primary: true };
  const git = async (...args: string[]) => (await exec('git', args)).stdout;

  await mkdir(seed, { recursive: true });
  await git('-C', seed, 'init', '--initial-branch=main');
  await writeFile(join(seed, 'tracked.txt'), 'installed doctor fixture\n');
  await git('-C', seed, 'add', 'tracked.txt');
  await git('-C', seed, '-c', 'user.name=AFK Test', '-c', 'user.email=afk@example.test', 'commit', '-m', 'baseline');
  await mkdir(dirname(bare), { recursive: true });
  await git('clone', '--bare', seed, bare);
  await git('-C', bare, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await mkdir(dirname(checkout), { recursive: true });
  await git('-C', bare, 'worktree', 'add', '--detach', checkout, 'HEAD');
  const journal = join(workspaceDataDirectory(workspace), 'executions', 'attempt.jsonl');
  await mkdir(dirname(journal), { recursive: true });
  await writeFile(journal, JSON.stringify({ phase: 'done', at: '2026-11-04T12:00:00Z' }) + '\n');
  await writeFile(executionManifestPath(workItemId), JSON.stringify({ schemaVersion: 1, workItemId,
    providerBacklogId: id, tracker: { platform: 'github', projectKey }, workingBranch: repository.workingBranch,
    repositories: [repository] }));
  const runtimeStore = new TaskRuntimeStore();
  const runId = `doctor-install-${id}`;
  if (option === '--fix') {
    const heartbeatAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await runtimeStore.start({ runId, backlogId: id, providerRef: workItemId, workspace, phase: 'implementing',
      status: 'running', sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
      startedAt: heartbeatAt, heartbeatAt });
  }

  const claimKey = (await executionOwnershipKeys(workspace))[0];
  const lock = new FilesystemClaimLock();
  const claim = await lock.acquire({ key: claimKey, owner: 'installed-doctor-regression', ttlMs: 1 });
  if (!claim) throw new Error('Could not create test ownership claim');
  const args = ['doctor', '--workspace-root', root, '--json', option, ...(option === '--cleanup' ? [workItemId] : [])];
  const parse = (output: string) => output.trim().split(/(?<=\})\n(?=\{)/).map(document => JSON.parse(document));
  try {
    await setTimeout(2);
    expect(Date.parse((await lock.inspect(claimKey)).expiresAt)).toBeLessThan(Date.now());
    const denied = await exec(installation.binary, args).then(() => { throw new Error('Expected doctor to report quarantine'); },
      error => { expect(error.code).toBe(1); return parse(error.stdout); });
    const quarantine = expect.stringContaining('quarantined by an unclosed owned execution');
    expect(denied[0].workspaces).toContainEqual(expect.objectContaining({ workItemId, reclaimableBytes: 0, reason: quarantine }));
    if (option === '--cleanup') expect(denied[0].cleanup).toMatchObject({ status: 'retained', bytes: 0, reason: quarantine });
    else expect(denied[1].skipped).toContainEqual(expect.objectContaining({ workItemId, reason: quarantine }));
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('installed doctor fixture\n');
    expect(await lock.inspect(claimKey)).toMatchObject({ claimId: claim.claimId });
  } finally {
    await claim.release();
  }
  const allowed = parse((await exec(installation.binary, args)).stdout);
  expect(allowed[0].diagnostics).toEqual([]);
  const reclaimed = option === '--cleanup' ? allowed[0].cleanup : allowed[1].reclaimed.find((item: { workItemId: string }) => item.workItemId === workItemId);
  expect(reclaimed.bytes).toBeGreaterThan(0);
  await expect(lstat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await git('-C', bare, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1);
  if (option === '--fix') {
    expect(allowed[0].workspaces).toContainEqual(expect.objectContaining({ workItemId, bytes: 0 }));
    expect(allowed[1].diagnostics).toEqual([]);
    await expect(runtimeStore.getActive(runId)).resolves.toBeUndefined();
    await expect(runtimeStore.listArchive()).resolves.toContainEqual(expect.objectContaining({ runId, status: 'failed' }));
  }
});
