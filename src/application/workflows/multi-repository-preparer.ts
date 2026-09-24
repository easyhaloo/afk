import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { BranchHandle } from '../../domain/branches/types';
import type { WorkflowRunRepository } from './run-request';
import type { RunOutcomeStatus } from './resource-scope';
import { gitLabCloneUrl } from '../../shared/gitlab-project';

export type RepositoryTargetState = 'missing' | 'empty' | 'nonempty';

export interface RepositoryGitSnapshot {
  branch?: string;
  head: string;
  status: string;
  workingBranchExisted: boolean;
  workingBranchHead?: string;
}

export interface MultiRepositoryPreparerDependencies {
  filesystem: {
    validateRepositoryPath(workspaceRoot: string, repoRoot: string): Promise<void>;
    inspectTarget(repoRoot: string): Promise<RepositoryTargetState>;
    removeTarget(repoRoot: string): Promise<void>;
  };
  lock: {
    acquire(workspaceRoot: string): Promise<{ release(): Promise<void> }>;
  };
  clone: {
    clone(url: string, repoRoot: string): Promise<void>;
  };
  git: {
    isRepository(repoRoot: string): Promise<boolean>;
    originUrl(repoRoot: string): Promise<string>;
    capture(repoRoot: string, workingBranch: string): Promise<RepositoryGitSnapshot>;
    fetchBase(repoRoot: string, baseBranch: string): Promise<void>;
    prepareWorkingBranch(repoRoot: string, baseBranch: string, workingBranch: string): Promise<void>;
    finalize(repoRoot: string, workingBranch: string): Promise<void>;
    restore(repoRoot: string, snapshot: RepositoryGitSnapshot, workingBranch: string): Promise<void>;
  };
}

export interface PreparedRepository extends WorkflowRunRepository {
  handle: BranchHandle;
  createdByRun: boolean;
  original: RepositoryGitSnapshot;
}

export interface PreparedRepositorySet {
  repositories: PreparedRepository[];
  primary: PreparedRepository;
  finish(outcome: { status: RunOutcomeStatus }): Promise<void>;
}

export interface MultiRepositoryPreparationService {
  prepare(repositories: readonly WorkflowRunRepository[], workspaceRoot: string): Promise<PreparedRepositorySet>;
}

export interface WorkspaceLockDependencies {
  ensureDirectory(path: string): Promise<void>;
  isSymbolicLink(path: string): Promise<boolean>;
  createDirectory(path: string): Promise<void>;
  writeOwner(path: string, contents: string): Promise<void>;
  readOwner(path: string): Promise<string>;
  statDirectory(path: string): Promise<{ ino: number; birthtimeMs: number; mtimeMs: number }>;
  rename(from: string, to: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  processAlive(pid: number): Promise<boolean>;
  pid: number;
  now(): Date;
  ownerId(): string;
  uniqueId(): string;
  initializationGraceMs: number;
}

export class MultiRepositoryPreparer implements MultiRepositoryPreparationService {
  constructor(private readonly dependencies: MultiRepositoryPreparerDependencies = defaultDependencies()) {}

  async prepare(repositories: readonly WorkflowRunRepository[], workspaceRoot: string): Promise<PreparedRepositorySet> {
    const primaryCount = repositories.filter(repository => repository.primary).length;
    if (primaryCount !== 1) throw new Error('repositories must contain exactly one primary repository');
    if (new Set(repositories.map(repository => repository.workingBranch)).size !== 1) {
      throw new Error('repositories must use the same working branch');
    }

    const lock = await this.dependencies.lock.acquire(workspaceRoot);
    const prepared: PreparedRepository[] = [];
    try {
      for (const repository of repositories) {
        await this.dependencies.filesystem.validateRepositoryPath(workspaceRoot, repository.repoRoot);
      }
      for (const repository of repositories) prepared.push(await this.prepareOne(repository));
    } catch (error) {
      await this.cleanup(prepared, error);
      try { await lock.release(); } catch { /* preserve the preparation error */ }
      throw error;
    }

    const primary = prepared.find(repository => repository.primary)!;
    let finishPromise: Promise<void> | undefined;
    return {
      repositories: prepared,
      primary,
      finish: outcome => {
        finishPromise ??= this.finish(prepared, outcome.status).then(
          () => lock.release(),
          async error => {
            try { await lock.release(); } catch { /* preserve the terminal error */ }
            throw error;
          },
        );
        return finishPromise;
      },
    };
  }

  private async prepareOne(repository: WorkflowRunRepository): Promise<PreparedRepository> {
    const targetState = await this.dependencies.filesystem.inspectTarget(repository.repoRoot);
    const createdByRun = targetState !== 'nonempty';
    let original: RepositoryGitSnapshot | undefined;
    let branchPreparationStarted = false;
    try {
      if (createdByRun) {
        await this.dependencies.clone.clone(cloneUrl(repository), repository.repoRoot);
      } else if (!await this.dependencies.git.isRepository(repository.repoRoot)) {
        throw new Error(`repository target is not a git repository: ${repository.repoRoot}`);
      }
      if (!await this.dependencies.git.isRepository(repository.repoRoot)) {
        throw new Error(`repository clone is not a git repository: ${repository.repoRoot}`);
      }
      assertRepositoryOrigin(repository, await this.dependencies.git.originUrl(repository.repoRoot));

      original = await this.dependencies.git.capture(repository.repoRoot, repository.workingBranch);
      if (original.status) {
        throw new Error(`repository has uncommitted changes: ${repository.repoRoot}`);
      }
      await this.dependencies.git.fetchBase(repository.repoRoot, repository.baseBranch);
      branchPreparationStarted = true;
      await this.dependencies.git.prepareWorkingBranch(
        repository.repoRoot,
        repository.baseBranch,
        repository.workingBranch,
      );
      return {
        ...repository,
        handle: {
          branch: repository.workingBranch,
          path: repository.repoRoot,
          isNewBranch: !original.workingBranchExisted,
        },
        createdByRun,
        original,
      };
    } catch (error) {
      if (createdByRun) {
        await this.dependencies.filesystem.removeTarget(repository.repoRoot).catch(() => undefined);
      } else if (original && branchPreparationStarted) {
        await this.dependencies.git.restore(repository.repoRoot, original, repository.workingBranch).catch(() => undefined);
      }
      throw error;
    }
  }

  private async finish(repositories: PreparedRepository[], status: RunOutcomeStatus): Promise<void> {
    if (status !== 'success') return;
    const errors: unknown[] = [];
    for (const repository of repositories) {
      try {
        await this.dependencies.git.finalize(repository.repoRoot, repository.workingBranch);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'multiple repository finalizations failed');
    await this.cleanup(repositories);
  }

  private async cleanup(repositories: PreparedRepository[], initialError?: unknown): Promise<void> {
    let firstError = initialError;
    for (const repository of [...repositories].reverse()) {
      try {
        if (repository.createdByRun) await this.dependencies.filesystem.removeTarget(repository.repoRoot);
        else await this.dependencies.git.restore(repository.repoRoot, repository.original, repository.workingBranch);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (initialError === undefined && firstError !== undefined) throw firstError;
  }
}

export function cloneUrl(repository: Pick<WorkflowRunRepository, 'platform' | 'projectKey' | 'providerHost'>): string {
  if (repository.platform === 'github') return `https://github.com/${repository.projectKey}.git`;
  return gitLabCloneUrl(repository.projectKey, repository.providerHost);
}

export function assertRepositoryOrigin(
  repository: Pick<WorkflowRunRepository, 'platform' | 'projectKey' | 'providerHost'>,
  originUrl: string,
): void {
  const expected = parseRemoteIdentity(cloneUrl(repository));
  const actual = parseRemoteIdentity(originUrl);
  const expectedPath = repository.platform === 'github' ? expected?.path.toLowerCase() : expected?.path;
  const actualPath = repository.platform === 'github' ? actual?.path.toLowerCase() : actual?.path;
  if (!actual || actual.host !== expected?.host || actualPath !== expectedPath) {
    throw new Error(`repository origin does not match ${repository.platform}:${repository.projectKey}`);
  }
}

function parseRemoteIdentity(value: string): { host: string; path: string } | null {
  const remote = value.trim();
  const scp = /^git@([^:/\s]+):([^\s]+)$/.exec(remote);
  if (scp) return remoteIdentity(scp[1], scp[2]);
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash) return null;
    if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return null;
    return remoteIdentity(url.host, url.pathname);
  } catch {
    return null;
  }
}

function remoteIdentity(host: string, rawPath: string): { host: string; path: string } | null {
  const path = rawPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !path || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  return { host: host.toLowerCase(), path };
}

function defaultDependencies(): MultiRepositoryPreparerDependencies {
  return {
    filesystem: {
      validateRepositoryPath,
      inspectTarget: async repoRoot => {
        try {
          const stat = await fs.stat(repoRoot);
          if (!stat.isDirectory()) return 'nonempty';
          return (await fs.readdir(repoRoot)).length === 0 ? 'empty' : 'nonempty';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
          throw error;
        }
      },
      removeTarget: repoRoot => fs.rm(repoRoot, { recursive: true, force: true }),
    },
    lock: {
      acquire: acquireWorkspaceLock,
    },
    clone: {
      clone: async (url, repoRoot) => {
        await fs.mkdir(dirname(repoRoot), { recursive: true });
        await simpleGit().clone(url, repoRoot);
      },
    },
    git: {
      isRepository: async repoRoot => {
        try {
          return await simpleGit(repoRoot).checkIsRepo();
        } catch {
          return false;
        }
      },
      originUrl: repoRoot => simpleGit(repoRoot).raw(['config', '--get', 'remote.origin.url']),
      capture: async (repoRoot, workingBranch) => {
        const git = simpleGit(repoRoot);
        const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
        const head = (await git.revparse(['HEAD'])).trim();
        const status = (await git.raw(['status', '--porcelain=v1'])).trim();
        const workingBranchHead = await localBranchHead(repoRoot, workingBranch);
        return {
          ...(branch === 'HEAD' ? {} : { branch }),
          head,
          status,
          workingBranchExisted: workingBranchHead !== undefined,
          ...(workingBranchHead ? { workingBranchHead } : {}),
        };
      },
      fetchBase: async (repoRoot, baseBranch) => {
        const git = simpleGit(repoRoot);
        await git.fetch('origin', baseBranch);
        await git.revparse([`origin/${baseBranch}`]);
      },
      prepareWorkingBranch: async (repoRoot, baseBranch, workingBranch) => {
        const git = simpleGit(repoRoot);
        if (await localBranchHead(repoRoot, workingBranch)) {
          await git.raw(['checkout', workingBranch]);
        } else {
          await git.raw(['checkout', '-b', workingBranch, `origin/${baseBranch}`]);
        }
      },
      finalize: async (repoRoot, workingBranch) => {
        await simpleGit(repoRoot).push('origin', workingBranch, ['--set-upstream']);
      },
      restore: restoreRepository,
    },
  };
}

async function validateRepositoryPath(workspaceRoot: string, repoRoot: string): Promise<void> {
  const absoluteWorkspace = resolve(workspaceRoot);
  const absoluteRepository = resolve(repoRoot);
  assertInsideWorkspace(absoluteWorkspace, absoluteRepository, repoRoot);

  const workspaceRealPath = await fs.realpath(absoluteWorkspace);
  const relativeRepository = relative(absoluteWorkspace, absoluteRepository);
  let current = absoluteWorkspace;
  for (const segment of relativeRepository.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`repository path contains a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }

  try {
    const repositoryRealPath = await fs.realpath(absoluteRepository);
    assertInsideWorkspace(workspaceRealPath, repositoryRealPath, repoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertInsideWorkspace(workspaceRoot: string, target: string, label: string): void {
  const relativeTarget = relative(workspaceRoot, target);
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeTarget)) {
    throw new Error(`repository path escapes execution workspace: ${label}`);
  }
}

export async function acquireWorkspaceLock(
  workspaceRoot: string,
  dependencies: WorkspaceLockDependencies = defaultWorkspaceLockDependencies(),
): Promise<{ release(): Promise<void> }> {
  const afkDirectory = join(resolve(workspaceRoot), '.afk');
  await dependencies.ensureDirectory(afkDirectory);
  if (await dependencies.isSymbolicLink(afkDirectory)) {
    throw new Error(`execution workspace lock directory must not be a symbolic link: ${afkDirectory}`);
  }
  const lockDirectory = join(afkDirectory, 'multi-repository-preparation.lock');
  const ownerPath = join(lockDirectory, 'owner.json');
  const token = dependencies.ownerId();
  const ownerContents = JSON.stringify({
    pid: dependencies.pid,
    startedAt: dependencies.now().toISOString(),
    token,
  });
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await dependencies.createDirectory(lockDirectory);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const inspection = await inspectWorkspaceLock(dependencies, lockDirectory, ownerPath);
      if (inspection.state === 'missing') continue;
      if (inspection.state === 'active') {
        throw new Error(`workspace preparation is already locked: ${workspaceRoot}`);
      }
      const tombstoneDirectory = join(afkDirectory, `multi-repository-preparation.stale-${inspection.generation}`);
      try {
        await dependencies.rename(lockDirectory, tombstoneDirectory);
      } catch (renameError) {
        if (hasCode(renameError, 'ENOENT') || hasCode(renameError, 'EEXIST') || hasCode(renameError, 'ENOTEMPTY')) continue;
        throw renameError;
      }
      continue;
    }

    try {
      await dependencies.writeOwner(ownerPath, ownerContents);
    } catch (error) {
      await moveFailedOwnerLockToTombstone(dependencies, afkDirectory, lockDirectory, token);
      throw error;
    }

    let releasePromise: Promise<void> | undefined;
    return {
      release: () => {
        releasePromise ??= releaseOwnedLock(dependencies, lockDirectory, ownerPath, token);
        return releasePromise;
      },
    };
  }
  throw new Error(`workspace preparation lock changed while acquiring: ${workspaceRoot}`);
}

function defaultWorkspaceLockDependencies(): WorkspaceLockDependencies {
  return {
    ensureDirectory: async path => { await fs.mkdir(path, { recursive: true }); },
    isSymbolicLink: async path => (await fs.lstat(path)).isSymbolicLink(),
    createDirectory: async path => { await fs.mkdir(path); },
    writeOwner: (path, contents) => fs.writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
    readOwner: path => fs.readFile(path, 'utf8'),
    statDirectory: async path => {
      const stat = await fs.stat(path);
      return { ino: stat.ino, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs };
    },
    rename: (from, to) => fs.rename(from, to),
    removeDirectory: path => fs.rm(path, { recursive: true, force: true }),
    processAlive: async pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (hasCode(error, 'EPERM')) return true;
        if (hasCode(error, 'ESRCH')) return false;
        throw error;
      }
    },
    pid: process.pid,
    now: () => new Date(),
    ownerId: randomUUID,
    uniqueId: randomUUID,
    initializationGraceMs: 30_000,
  };
}

async function inspectWorkspaceLock(
  dependencies: WorkspaceLockDependencies,
  lockDirectory: string,
  ownerPath: string,
): Promise<{ state: 'active' } | { state: 'missing' } | { state: 'stale'; generation: string }> {
  let ownerContents: string | undefined;
  try {
    ownerContents = await dependencies.readOwner(ownerPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }

  const owner = ownerContents === undefined ? undefined : parseWorkspaceLock(ownerContents);
  if (owner) {
    return await dependencies.processAlive(owner.pid)
      ? { state: 'active' }
      : { state: 'stale', generation: workspaceLockGeneration(`owner:${owner.token}`) };
  }

  try {
    const stat = await dependencies.statDirectory(lockDirectory);
    if (dependencies.now().getTime() - stat.mtimeMs < dependencies.initializationGraceMs) return { state: 'active' };
    return {
      state: 'stale',
      generation: workspaceLockGeneration(`stat:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}`),
    };
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { state: 'missing' };
    throw error;
  }
}

function workspaceLockGeneration(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function parseWorkspaceLock(contents: string): { pid: number; startedAt: string; token: string } | undefined {
  try {
    const value = JSON.parse(contents) as { pid?: unknown; startedAt?: unknown; token?: unknown };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) return undefined;
    if (typeof value.token !== 'string' || !value.token) return undefined;
    return { pid: value.pid as number, startedAt: value.startedAt, token: value.token };
  } catch {
    return undefined;
  }
}

async function releaseOwnedLock(
  dependencies: WorkspaceLockDependencies,
  lockDirectory: string,
  ownerPath: string,
  token: string,
): Promise<void> {
  let ownerContents: string;
  try {
    ownerContents = await dependencies.readOwner(ownerPath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  if (parseWorkspaceLock(ownerContents)?.token !== token) return;
  await moveLockDirectoryForCleanup(dependencies, lockDirectory, 'release');
}

async function moveLockDirectoryForCleanup(
  dependencies: WorkspaceLockDependencies,
  lockDirectory: string,
  purpose: 'failed' | 'release',
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const destination = `${lockDirectory}.${purpose}-${dependencies.uniqueId()}`;
    try {
      await dependencies.rename(lockDirectory, destination);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      if (hasCode(error, 'EEXIST')) continue;
      throw error;
    }
    await dependencies.removeDirectory(destination);
    return;
  }
  throw new Error(`workspace preparation lock could not be moved for ${purpose}`);
}

async function moveFailedOwnerLockToTombstone(
  dependencies: WorkspaceLockDependencies,
  afkDirectory: string,
  lockDirectory: string,
  token: string,
): Promise<void> {
  const tombstoneDirectory = join(
    afkDirectory,
    `multi-repository-preparation.stale-${workspaceLockGeneration(`owner:${token}`)}`,
  );
  try {
    await dependencies.rename(lockDirectory, tombstoneDirectory);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

async function localBranchHead(repoRoot: string, branch: string): Promise<string | undefined> {
  try {
    return (await simpleGit(repoRoot).revparse([`refs/heads/${branch}`])).trim();
  } catch {
    return undefined;
  }
}

async function restoreRepository(
  repoRoot: string,
  snapshot: RepositoryGitSnapshot,
  workingBranch: string,
): Promise<void> {
  const git = simpleGit(repoRoot);
  if (snapshot.branch) await git.raw(['checkout', snapshot.branch]);
  else await git.raw(['checkout', '--detach', snapshot.head]);
  await git.raw(['reset', '--hard', snapshot.head]);

  if (snapshot.branch !== workingBranch) {
    if (snapshot.workingBranchExisted && snapshot.workingBranchHead) {
      await git.raw(['branch', '-f', workingBranch, snapshot.workingBranchHead]);
    } else {
      await git.raw(['branch', '-D', workingBranch]).catch(() => undefined);
    }
  }
  await git.raw(['clean', '-fd']);
}
