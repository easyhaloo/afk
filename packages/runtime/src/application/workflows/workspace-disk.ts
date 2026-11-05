import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { glob } from 'glob';
import { simpleGit } from 'simple-git';
import { directoryBytes } from '../../infrastructure/git/dependency-pool.js';
import { RepositoryLeases } from '../../infrastructure/git/repository-lease.js';
import { resolveWorkspaceRoot, workspaceStateDirectory, executionWorkspacePath, workspaceDataDirectory } from '../../infrastructure/workspace.js';
import { readExecutionManifest } from './execution-manifest.js';

export interface WorkspaceDiskReport {
  root: string;
  repositories: Array<{ path: string; bytes: number; checkouts: number }>;
  dependencies: Array<{ path: string; bytes: number; pinned: boolean }>;
  workspaces: Array<{ workItemId: string; path: string; bytes: number; active: boolean | null; state?: string; reclaimableBytes: number }>;
  totals: { repositoryBytes: number; dependencyBytes: number; workspaceBytes: number; reclaimableBytes: number };
  diagnostics: string[];
}

export async function inspectWorkspaceDisk(options: {
  root?: string;
  manifests?: string[];
  leases?: Pick<RepositoryLeases, 'active'>;
} = {}): Promise<WorkspaceDiskReport> {
  const root = resolve(options.root ?? resolveWorkspaceRoot());
  const report: WorkspaceDiskReport = { root, repositories: [], dependencies: [], workspaces: [],
    totals: { repositoryBytes: 0, dependencyBytes: 0, workspaceBytes: 0, reclaimableBytes: 0 }, diagnostics: [] };
  const measure = async (path: string): Promise<number> => {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`cache must not be a symlink: ${path}`);
    return directoryBytes(path);
  };
  for (const head of await glob('repos/**/bare.git/HEAD', { cwd: root, dot: true, follow: false })) {
    const path = dirname(join(root, head));
    try {
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
      let pinned = false;
      for (const pin of await readdir(join(path, 'pins'))) {
        const target = await readFile(join(path, 'pins', pin), 'utf8');
        if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) pinned = true;
      }
      report.dependencies.push({ path, bytes, pinned });
      report.totals.dependencyBytes += bytes;
      if (!pinned) report.totals.reclaimableBytes += bytes;
    } catch (error) { report.diagnostics.push(`${path}: ${String(error)}`); }
  }
  const manifests = options.manifests ?? await glob(join(workspaceStateDirectory(), 'workspaces/*/execution-manifest.json'), { follow: false });
  const seen = new Set<string>();
  for (const path of manifests) {
    try {
      const identity = JSON.parse(await readFile(path, 'utf8')).workItemId;
      const manifest = await readExecutionManifest(path, identity);
      const workspace = executionWorkspacePath(manifest.workItemId, root);
      const location = relative(root, manifest.workspaceRoot);
      if (!location || location.startsWith(`..${sep}`) || location === '..' || isAbsolute(location) || resolve(manifest.workspaceRoot) !== workspace || seen.has(workspace)) continue;
      seen.add(workspace);
      const bytes = await lstat(workspace).then(() => measure(workspace), error => { if (error.code === 'ENOENT') return 0; throw error; });
      const active = await (options.leases ?? new RepositoryLeases()).active(manifest.repositories.map(repository => `${repository.platform}:${repository.projectKey}`));
      const journals = await glob(join(workspaceDataDirectory(workspace), 'executions/*.jsonl'));
      let latest: { phase: string; at: string } | undefined;
      for (const journal of journals) {
        const lines = (await readFile(journal, 'utf8')).trim().split('\n');
        const entry = JSON.parse(lines.at(-1)!);
        if (typeof entry.phase === 'string' && typeof entry.at === 'string' && (!latest || entry.at > latest.at)) latest = entry;
      }
      const reclaimableBytes = !active && ['merge_ready', 'done'].includes(latest?.phase ?? '') ? bytes : 0;
      report.workspaces.push({ workItemId: manifest.workItemId, path: workspace, bytes, active, state: latest?.phase, reclaimableBytes });
      report.totals.workspaceBytes += bytes;
      report.totals.reclaimableBytes += reclaimableBytes;
    } catch (error) { report.diagnostics.push(`${path}: ${String(error)}`); }
  }
  const legacyRoots = (await glob('**/.git', { cwd: root, dot: true, follow: false,
    ignore: ['repos/**', 'deps/**', '**/node_modules/**'] })).map(path => {
      const parts = path.split('/');
      const repositories = parts.indexOf('repositories');
      return join(root, ...parts.slice(0, repositories < 0 ? -1 : repositories));
    }).sort((left, right) => left.length - right.length);
  for (const path of legacyRoots) {
    if ([...seen].some(parent => path === parent || path.startsWith(`${parent}${sep}`))) continue;
    seen.add(path);
    try {
      const bytes = await measure(path);
      report.workspaces.push({ workItemId: relative(root, path), path, bytes, active: null, state: 'unverified', reclaimableBytes: 0 });
      report.totals.workspaceBytes += bytes;
    } catch (error) { report.diagnostics.push(`${path}: ${String(error)}`); }
  }
  return report;
}
