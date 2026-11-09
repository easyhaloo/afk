import { lstat, readFile, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { glob } from 'glob';
import { simpleGit } from 'simple-git';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { directoryBytes } from '../../infrastructure/git/dependency-pool.js';
import { RepositoryLeases } from '../../infrastructure/git/repository-lease.js';
import { RepositoryStore } from '../../infrastructure/git/repository-store.js';
import { resolveWorkspaceRoot, workspaceStateDirectory, executionWorkspacePath, workspaceDataDirectory } from '../../infrastructure/workspace.js';
import { parseExecutionManifest, type ExecutionManifest } from './execution-manifest.js';

export interface WorkspaceDiskReport {
  root: string;
  repositories: Array<{ path: string; bytes: number; checkouts: number }>;
  dependencies: Array<{ path: string; bytes: number; pinned: boolean }>;
  workspaces: Array<{ workItemId: string; path: string; bytes: number; active: boolean | null; state?: string; reclaimableBytes: number; reason?: string }>;
  totals: { repositoryBytes: number; dependencyBytes: number; workspaceBytes: number; reclaimableBytes: number };
  diagnostics: string[];
  cleanup?: { target: string; path?: string; status: 'removed' | 'retained' | 'partial'; bytes: number; reason?: string };
}

type DiskOptions = {
  root?: string;
  manifests?: string[];
  leases?: Pick<RepositoryLeases, 'active'> & Partial<Pick<RepositoryLeases, 'run'>>;
  cleanup?: string;
};

function contains(root: string, path: string): boolean {
  const location = relative(root, path);
  return location !== '' && location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
}

async function safePath(root: string, path: string): Promise<void> {
  if (path !== root && !contains(root, path)) throw new Error(`path escapes workspace root: ${path}`);
  let current = root;
  for (const segment of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`path must not be a symlink: ${current}`);
  }
}

async function onlyContents(root: string, path: string, allowed: string[]): Promise<void> {
  await safePath(root, path);
  if (allowed.includes(path)) return;
  if (!allowed.some(target => contains(path, target))) throw new Error(`unrecognized generated contents: ${path}`);
  for (const entry of await readdir(path)) await onlyContents(root, join(path, entry), allowed);
}

async function dependencyPinned(root: string, path: string): Promise<boolean> {
  if (dirname(path) !== join(root, 'deps') || !/^[a-f0-9]{64}$/.test(relative(join(root, 'deps'), path))) {
    throw new Error('unrecognized dependency pool entry');
  }
  await safePath(root, join(path, 'complete.json'));
  const value = JSON.parse(await readFile(join(path, 'complete.json'), 'utf8'));
  if (!value || Object.keys(value).some(key => key !== 'paths') || !Array.isArray(value.paths) || !value.paths.length || value.paths.some((entry: unknown) => typeof entry !== 'string'
    || isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.includes('\\')
    || entry.split('/').some(segment => !segment || segment === '..' || segment === '.') || entry.split('/').at(-1) !== 'node_modules')) {
    throw new Error('invalid dependency pool paths');
  }
  await onlyContents(root, join(path, 'layout'), value.paths.map((entry: string) => join(path, 'layout', entry)));
  await safePath(root, join(path, 'pins'));
  let pinned = false;
  for (const pin of await readdir(join(path, 'pins'))) {
    await safePath(root, join(path, 'pins', pin));
    const target = await readFile(join(path, 'pins', pin), 'utf8');
    if (!isAbsolute(target)) throw new Error('invalid dependency pin');
    if (await exists(target)) pinned = true;
  }
  if ((await readdir(path)).some(entry => !['complete.json', 'layout', 'pins'].includes(entry))) throw new Error('unrecognized dependency pool contents');
  return pinned;
}

async function completionState(workspace: string): Promise<{ state?: string; completed: boolean }> {
  const executions = join(workspaceDataDirectory(workspace), 'executions');
  if (!await exists(executions)) return { completed: false };
  await safePath(workspaceStateDirectory(), executions);
  const entries = await readdir(executions);
  if (entries.some(entry => !entry.endsWith('.jsonl'))) return { state: 'execution lock or unknown evidence', completed: false };
  let latest: { phase: string; at: string } | undefined;
  let completed = entries.length > 0;
  for (const entry of entries) {
    const journal = join(executions, entry);
    await safePath(workspaceStateDirectory(), journal);
    const records = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (records.some(record => typeof record.phase !== 'string' || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)))) {
      throw new Error('invalid execution journal');
    }
    const last = records.at(-1)!;
    completed &&= ['merge_ready', 'done'].includes(last.phase);
    if (!latest || Date.parse(last.at) > Date.parse(latest.at)) latest = last;
  }
  return { state: latest?.phase, completed };
}

async function assertNoTasks(workspace: string, manifest: ExecutionManifest): Promise<void> {
  const active = join(workspaceStateDirectory(), 'runtime/tasks/active');
  if (!await exists(active)) return;
  await safePath(workspaceStateDirectory(), active);
  for (const entry of await readdir(active)) {
    const path = join(active, entry);
    await safePath(workspaceStateDirectory(), path);
    const task = JSON.parse(await readFile(path, 'utf8'));
    if (!task || typeof task.backlogId !== 'string' || typeof task.status !== 'string'
      || (task.workspace !== undefined && (typeof task.workspace !== 'string' || !isAbsolute(task.workspace)))
      || (task.worktree !== undefined && (typeof task.worktree !== 'string' || !isAbsolute(task.worktree)))
      || (task.providerRef !== undefined && typeof task.providerRef !== 'string')) throw new Error('unknown active task metadata');
    const paths = [task.workspace, task.worktree].filter((target): target is string => typeof target === 'string');
    const identities = [task.backlogId, task.providerRef].filter((id): id is string => typeof id === 'string' && /[:#]/.test(id))
      .map(id => parseWorkItemId(id).id);
    const canonicalWorkspace = await realpath(workspace);
    const canonicalPaths = await Promise.all(paths.map(target => realpath(target).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    })));
    const matchingPath = [...paths, ...canonicalPaths].some(target => target !== undefined
      && (resolve(target) === workspace || contains(workspace, resolve(target)) || contains(resolve(target), workspace)
        || target === canonicalWorkspace || contains(canonicalWorkspace, target) || contains(target, canonicalWorkspace)));
    if (matchingPath || identities.some(id => id === manifest.workItemId)
      || (task.backlogId === manifest.providerBacklogId && !identities.length
        && (!paths.length || canonicalPaths.some(target => target === undefined)))) {
      throw new Error('workspace has an active or unresolved verification/execution task');
    }
  }
}

async function safeCheckouts(root: string, workspace: string, manifest: ExecutionManifest, removed: readonly string[] = []): Promise<string[]> {
  await safePath(root, workspace);
  await assertNoTasks(workspace, manifest);
  const store = new RepositoryStore(join(root, 'repos'));
  const checkouts: string[] = [];
  for (const repository of manifest.repositories) {
    const checkout = resolve(workspace, repository.checkoutPath.replace(/\\/g, '/'));
    if (removed.includes(checkout)) continue;
    if (!contains(workspace, checkout)) throw new Error('checkout path escapes workspace');
    await safePath(root, join(checkout, '.git'));
    if (!(await lstat(join(checkout, '.git'))).isFile() || !await store.ownsCheckout(checkout)) {
      throw new Error('source or unmanaged checkout is retained');
    }
    const git = simpleGit(checkout);
    if (await realpath(checkout) !== await realpath((await git.revparse(['--show-toplevel'])).trim())) throw new Error('checkout root mismatch');
    const common = resolve(checkout, (await git.revparse(['--git-common-dir'])).trim());
    const canonicalStore = await realpath(join(root, 'repos'));
    const canonicalCommon = await realpath(common);
    await safePath(root, join(root, 'repos', relative(canonicalStore, canonicalCommon)));
    if (!contains(canonicalStore, canonicalCommon) || !canonicalCommon.endsWith(`${sep}bare.git`)) throw new Error('unrecognized repository store');
    if ((await git.raw(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])).trim()) {
      throw new Error('checkout contains uncommitted or nonignored files');
    }
    if ((await git.raw(['ls-files', '-v', '-z'])).split('\0').some(entry => /^[a-zS] /.test(entry))) {
      throw new Error('checkout hides tracked changes with assume-unchanged or skip-worktree');
    }
    if (!(await git.raw(['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes/'])).trim()) {
      throw new Error('checkout contains unpublished commits');
    }
    const worktrees = (await simpleGit(common).raw(['worktree', 'list', '--porcelain', '-z'])).split('\0');
    const canonicalCheckout = await realpath(checkout);
    if (worktrees.some(entry => entry.startsWith('worktree ') && contains(canonicalCheckout, entry.slice(9)))
      || (await glob('**/.git', { cwd: checkout, dot: true, follow: false, ignore: ['**/.git/**'] })).some(path => path !== '.git')) {
      throw new Error('nested verification worktree is retained');
    }
    if ((await git.raw(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).length) {
      throw new Error('checkout contains ignored content');
    }
    checkouts.push(checkout);
  }
  await onlyContents(root, workspace, checkouts);
  return checkouts;
}

export async function inspectWorkspaceDisk(options: DiskOptions = {}): Promise<WorkspaceDiskReport> {
  const root = resolve(options.root ?? resolveWorkspaceRoot());
  const leases = options.leases ?? new RepositoryLeases();
  const report: WorkspaceDiskReport = { root, repositories: [], dependencies: [], workspaces: [],
    totals: { repositoryBytes: 0, dependencyBytes: 0, workspaceBytes: 0, reclaimableBytes: 0 }, diagnostics: [] };
  const manifestsByWorkspace = new Map<string, ExecutionManifest>();
  const measure = async (path: string): Promise<number> => { await safePath(root, path); return directoryBytes(path); };
  try { if (await exists(root)) await safePath(root, root); }
  catch (error) { report.diagnostics.push(String(error)); return report; }
  for (const head of await glob('repos/**/bare.git/HEAD', { cwd: root, dot: true, follow: false })) {
    const path = dirname(join(root, head));
    try {
      await safePath(root, join(path, 'HEAD'));
      const bytes = await measure(path);
      const worktrees = await simpleGit(path).raw(['worktree', 'list', '--porcelain']);
      report.repositories.push({ path, bytes, checkouts: Math.max(0, (worktrees.match(/^worktree /gm) ?? []).length - 1) });
      report.totals.repositoryBytes += bytes;
    } catch (error) { report.diagnostics.push(`${path}: ${String(error)}`); }
  }
  for (const marker of await glob('deps/*/complete.json', { cwd: root, dot: true, follow: false })) {
    const path = dirname(join(root, marker));
    try {
      const bytes = await measure(path);
      const pinned = await dependencyPinned(root, path);
      report.dependencies.push({ path, bytes, pinned });
      report.totals.dependencyBytes += bytes;
      if (!pinned) report.totals.reclaimableBytes += bytes;
    } catch (error) { report.diagnostics.push(`${path}: ${String(error)}`); }
  }
  const manifests = options.manifests ?? await glob(join(workspaceStateDirectory(), 'workspaces/*/execution-manifest.json'), { follow: false });
  const seen = new Set<string>();
  for (const path of manifests) {
    try {
      await safePath(dirname(path), path);
      if (contains(workspaceStateDirectory(), resolve(path))) await safePath(workspaceStateDirectory(), resolve(path));
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest');
      const identity = value.workItemId ?? value.backlogId;
      if (typeof identity !== 'string') throw new Error('missing work item identity');
      const workspace = executionWorkspacePath(identity, root);
      if (!contains(root, workspace) || /^(repos|deps)(?:[\\/]|$)/.test(relative(root, workspace))) throw new Error('workspace path is reserved or escapes root');
      if (value.workspaceRoot !== undefined && (typeof value.workspaceRoot !== 'string' || resolve(value.workspaceRoot) !== workspace)) throw new Error('manifest workspace root mismatch');
      if (seen.has(workspace)) {
        const previous = report.workspaces.find(entry => entry.path === workspace)!;
        report.totals.reclaimableBytes -= previous.reclaimableBytes;
        previous.reclaimableBytes = 0;
        previous.reason = 'duplicate workspace manifest';
        manifestsByWorkspace.delete(workspace);
        throw new Error('duplicate workspace manifest');
      }
      const manifest = value.schemaVersion === undefined || value.schemaVersion === 0 ? undefined : parseExecutionManifest(value, { manifestPath: path, backlogId: identity });
      const bytes = await exists(workspace) ? await measure(workspace) : 0;
      seen.add(workspace);
      const entry: WorkspaceDiskReport['workspaces'][number] = { workItemId: identity, path: workspace, bytes, active: null, reclaimableBytes: 0 };
      report.workspaces.push(entry);
      report.totals.workspaceBytes += bytes;
      if (!manifest) { entry.state = 'legacy'; entry.reason = 'legacy manifest is read-only'; continue; }
      manifestsByWorkspace.set(workspace, manifest);
      try {
        entry.active = await leases.active(manifest.repositories.map(repository => `${repository.platform}:${repository.projectKey}`));
        const completion = await completionState(workspace);
        entry.state = completion.state;
        if (entry.active !== false) entry.reason = 'active repository lease';
        else if (!completion.completed) entry.reason = 'execution is not safely completed';
        else if (bytes > 0) {
          await safeCheckouts(root, workspace, manifest);
          entry.reclaimableBytes = bytes;
          report.totals.reclaimableBytes += bytes;
        }
      } catch (error) { entry.reason = String(error); report.diagnostics.push(`${workspace}: ${String(error)}`); }
    } catch (error) { report.diagnostics.push(`${path}: ${String(error)}`); }
  }
  const legacyRoots = (await glob('**/.git', { cwd: root, dot: true, follow: false,
    ignore: ['repos/**', 'deps/**', '**/node_modules/**'] })).map(path => {
      const parts = path.split('/');
      const repositories = parts.indexOf('repositories');
      return join(root, ...parts.slice(0, repositories < 0 ? -1 : repositories));
    }).sort((left, right) => left.length - right.length);
  for (const path of legacyRoots) {
    if (path === root || [...seen].some(parent => path === parent || contains(parent, path))) continue;
    seen.add(path);
    try {
      const bytes = await measure(path);
      report.workspaces.push({ workItemId: relative(root, path), path, bytes, active: null, state: 'unverified', reclaimableBytes: 0 });
      report.totals.workspaceBytes += bytes;
    } catch (error) { report.diagnostics.push(`${path}: ${String(error)}`); }
  }
  if (options.cleanup !== undefined) {
    const target = options.cleanup;
    const matches = [...report.workspaces, ...report.dependencies].filter(entry => entry.path === target || ('workItemId' in entry && entry.workItemId === target));
    report.cleanup = { target, status: 'retained', bytes: 0 };
    try {
      if (matches.length !== 1) throw new Error('cleanup requires one exact reported work item ID or absolute dependency/workspace path');
      const entry = matches[0];
      report.cleanup.path = entry.path;
      if ('workItemId' in entry) {
        const manifest = manifestsByWorkspace.get(entry.path);
        if (!manifest || entry.reclaimableBytes === 0) throw new Error(entry.reason ?? 'workspace is not reclaimable');
        if (!leases.run) throw new Error('repository lease acquisition is unavailable');
        await leases.run(manifest.repositories.map(repository => `${repository.platform}:${repository.projectKey}`), async () => {
          if (!(await completionState(entry.path)).completed) throw new Error('execution is no longer completed');
          const checkouts = await safeCheckouts(root, entry.path, manifest);
          const store = new RepositoryStore(join(root, 'repos'));
          const removed: string[] = [];
          for (const checkout of checkouts) {
            const bytes = await directoryBytes(checkout);
            await store.removeCheckout(checkout, { force: false, beforeRemove: async () => {
              if (!(await completionState(entry.path)).completed) throw new Error('execution is no longer completed');
              await safeCheckouts(root, entry.path, manifest, removed);
            } });
            removed.push(checkout);
            report.cleanup!.bytes += bytes;
          }
          for (const checkout of checkouts) {
            let parent = dirname(checkout);
            while (parent === entry.path || contains(entry.path, parent)) {
              try { await rmdir(parent); }
              catch (error) { if (['ENOTEMPTY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) break; throw error; }
              parent = dirname(parent);
            }
          }
        });
      } else {
        const pool = join(root, 'deps');
        await safePath(root, pool);
        await new FilesystemClaimLock(join(pool, '.locks')).withExclusiveOperation('dependencies/pool/operations', async () => {
          if (await dependencyPinned(root, entry.path)) throw new Error('dependency pool entry is pinned');
          await rm(entry.path, { recursive: true });
        });
      }
      report.cleanup.status = 'removed';
      report.cleanup.bytes = entry.bytes;
    } catch (error) {
      if (report.cleanup.bytes > 0) report.cleanup.status = 'partial';
      report.cleanup.reason = String(error);
      report.diagnostics.push(`Cleanup ${report.cleanup.status} ${target}: ${String(error)}`);
    }
  }
  return report;
}
