import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readFileSync, realpathSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type {
  ProviderOperationOptions,
  RepositoryProvider,
  RepositoryRef,
  RepositorySnapshot,
  RepositoryLifecycleOperation,
  RepositoryPrepareRequest,
  RepositoryCheckoutRequest,
  RepositoryPublishRequest,
  RepositoryWorkspaceRequest,
  RepositoryWorkspace,
  RepositoryPublication,
  RepositoryCleanupResult,
  RepositoryWorkspaceLease,
} from '../../plugin-sdk/capabilities.js';
import { RepositoryStore } from '../git/repository-store.js';
import { RepositoryLeases, repositoryClaimIds } from '../git/repository-lease.js';
import { withWorkspaceOwnershipAvailable } from '../runtime/workspace-ownership.js';
import { resolveOperationCredential, validateOperationCredential, type OperationSecret } from './operation-secret.js';
import { RepositoryRecoveryJournal, type RepositoryRecoveryRecord } from './repository-recovery.js';
import {
  checkAbort,
  executeCommand,
  requestHttp,
  type CommandExecutor,
  type CommandRequest,
  type CommandResult,
  type FetchTransport,
} from './dependencies.js';

const SNAPSHOT_ONLY: RepositoryProvider['capabilities'] = Object.freeze({
  read: true,
  clone: false,
  push: false,
});

const nativeWorkspaceLeases = new WeakSet<object>();
export function isNativeRepositoryWorkspaceLease(value: unknown): value is RepositoryWorkspaceLease {
  return typeof value === 'object' && value !== null && nativeWorkspaceLeases.has(value);
}

async function runRepositoryCommand(executor: CommandExecutor, request: CommandRequest, failureMessage?: string): Promise<CommandResult> {
  checkAbort(request);
  const controller = request.deadlineAt === undefined ? undefined : new AbortController();
  const abort = () => controller?.abort(request.signal?.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    if (controller?.signal.aborted) return;
    const remaining = request.deadlineAt! - Date.now();
    if (remaining > 0) timer = setTimeout(expire, Math.min(2_147_483_647, remaining));
    else controller?.abort(new Error('Repository command deadline exceeded'));
  };
  if (controller) {
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    expire();
  }
  const command = { ...request, signal: controller?.signal ?? request.signal };
  try {
    checkAbort(command);
    const result = await executor(command);
    checkAbort(command);
    return result;
  } catch (error) {
    checkAbort(command);
    if (failureMessage) throw new Error(failureMessage);
    throw error;
  } finally {
    clearTimeout(timer);
    if (controller) request.signal?.removeEventListener('abort', abort);
  }
}

/** Validate the common snapshot shape shared by the remote providers. */
function validateSnapshot(payload: unknown): RepositorySnapshot {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('repository snapshot response is not an object');
  }
  const record = payload as { commit?: unknown; branch?: unknown; dirty?: unknown };
  const commit = record.commit;
  const branch = record.branch;
  const dirty = record.dirty;
  if (typeof commit !== 'string' || commit.trim().length === 0) {
    throw new Error('repository snapshot is missing a commit');
  }
  if (typeof branch !== 'string' || branch.trim().length === 0) {
    throw new Error('repository snapshot is missing a branch');
  }
  if (typeof dirty !== 'boolean') {
    throw new Error('repository snapshot is missing a dirty flag');
  }
  return { commit: commit.trim(), branch: branch.trim(), dirty };
}

// --- Multi-repository (configured local checkouts via git) ---

export interface LocalRepositoryConfig {
  readonly name: string;
  /** Absolute path to the local checkout. */
  readonly path: string;
  readonly remoteUrl?: string;
  readonly baseBranch?: string;
  readonly leaseKey?: string;
}

export interface MultiRepositoryProviderOptions {
  readonly repositories: readonly LocalRepositoryConfig[];
  /** Defaults to the real `git` process via {@link executeCommand}. */
  readonly git?: CommandExecutor;
  readonly managed?: {
    readonly workspaceRoot: string;
    readonly store?: Pick<RepositoryStore, 'ensureCheckout' | 'ownsCheckout' | 'withCheckoutLock'>
      & Partial<Pick<RepositoryStore, 'removeCheckout'>>;
    readonly leases?: Pick<RepositoryLeases, 'run'>;
    readonly leaseStateRoot?: string;
  };
}

export class RepositoryPreparationCleanupError extends AggregateError {
  readonly allocation: Readonly<Pick<RepositoryWorkspace, 'id' | 'repository' | 'runId'> & { path: string }>;

  constructor(allocation: RepositoryPreparationCleanupError['allocation'], failure: unknown, cleanupError: unknown) {
    super([failure, cleanupError], `repository preparation and cleanup failed; allocation requires recovery: ${allocation.path}`, { cause: failure });
    this.name = 'RepositoryPreparationCleanupError';
    this.allocation = Object.freeze({ id: allocation.id, repository: Object.freeze({ ...allocation.repository }),
      runId: allocation.runId, path: allocation.path });
    Object.defineProperty(this, 'allocation', { writable: false, configurable: false });
  }
}

function recoveryConfiguration(config: LocalRepositoryConfig): string {
  return createHash('sha256').update(JSON.stringify([config.remoteUrl, config.baseBranch, config.leaseKey])).digest('hex');
}

export class MultiRepositoryProvider implements RepositoryProvider {
  readonly id = 'multi-repository';
  readonly capabilities: RepositoryProvider['capabilities'];
  readonly withLifecycleLease?: RepositoryProvider['withLifecycleLease'];
  readonly withWorkspaceLease?: RepositoryProvider['withWorkspaceLease'];

  private readonly git: CommandExecutor;
  private readonly byName = new Map<string, LocalRepositoryConfig>();
  private readonly lifecycle?: ConfiguredRepositoryLifecycle;
  private readonly recovery?: RepositoryRecoveryJournal;
  private readonly recover?: (id: string) => Promise<RepositoryCleanupResult>;

  constructor(options: MultiRepositoryProviderOptions) {
    this.git = options.git ?? executeCommand;
    for (const config of options.repositories) {
      if (!config.name.trim() || !config.path.trim()) throw new Error('repository name and path are required');
      if (this.byName.has(config.name)) throw new Error(`duplicate repository name: ${config.name}`);
      this.byName.set(config.name, { ...config });
    }
    this.capabilities = SNAPSHOT_ONLY;
    if (options.managed) {
      if (!isAbsolute(options.managed.workspaceRoot)) throw new Error('managed workspace root must be absolute');
      const root = resolve(options.managed.workspaceRoot);
      const store = options.managed.store ?? new RepositoryStore();
      const leases = options.managed.leases ?? new RepositoryLeases(options.managed.leaseStateRoot);
      const journal = this.recovery = new RepositoryRecoveryJournal(root, options.managed.leaseStateRoot);
      const nativeWorkspace = this.git === executeCommand && store instanceof RepositoryStore && leases instanceof RepositoryLeases;
      for (const config of this.byName.values()) {
        validateRemoteUrl(config.remoteUrl);
        validateBranch(config.baseBranch);
        if (!config.leaseKey || !/^(github|gitlab):[a-zA-Z0-9_./:-]+$/.test(config.leaseKey)) throw new Error('managed repository requires a canonical lease key');
      }
      this.recover = async id => {
        const record = await journal.get(id);
        const config = this.byName.get(record.allocation.repository.url);
        if (!config || record.leaseKey !== config.leaseKey || record.allocation.repository.ref !== config.baseBranch
          || record.configurationDigest !== recoveryConfiguration(config)) {
          throw new Error('Repository recovery differs from configured ownership');
        }
        if (record.phase === 'closed' && !record.reservationRemoval) return { removed: true };
        await journal.allowRecovery(record);
        return leases.run([record.leaseKey], async () => {
          const current = await journal.get(id);
          if (current.phase === 'closed' && !current.reservationRemoval) return { removed: true };
          if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error('Repository recovery record changed');
          if (current.phase === 'closed') {
            await journal.bindOwner(id);
            await journal.settleReservation(id);
            return { removed: true };
          }
          await journal.claimRecovery(id);
          try {
            const path = record.allocation.path;
            const metadata = await fs.lstat(path).catch(error => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
              throw error;
            });
            if (!metadata) {
              if (record.phase === 'intent') await journal.close(id);
              else if (record.reservationRemoval) await journal.settleReservation(id);
              else {
                if (!record.removal) throw new Error('Repository recovery allocation disappeared');
                const common = record.removal.common.path;
                if (!await store.ownsCheckout(common)) throw new Error('Repository recovery Store is not owned');
                await store.withCheckoutLock(common, async () => {
                  if (!await store.ownsCheckout(common)) throw new Error('Repository recovery Store is not owned');
                  await journal.assertRemovalComplete(record);
                  await journal.close(id);
                });
              }
              return { removed: true };
            }
            await journal.assertIdentity(record);
            if (!record.marker) {
              if ((await fs.readdir(path)).length) throw new Error('Repository recovery allocation ownership is unknown');
              await journal.removeReservation(id);
              return { removed: true };
            } else {
              if (!record.safeCommit || !store.removeCheckout) throw new Error('Repository recovery requires safe Store removal');
              await store.removeCheckout(path, { force: false, beforeRemove: async () => {
                await journal.assertIdentity(record);
                if (!await store.ownsCheckout(path)) throw new Error('Repository recovery checkout is not owned');
                const commit = (await executeCommand({ command: 'git', args: ['rev-parse', '--verify', 'HEAD'], cwd: path })).stdout.trim();
                if (commit !== record.safeCommit) throw new Error('Repository recovery refuses unpublished commits');
                await journal.removing(id);
              } });
            }
            await journal.close(id);
            return { removed: true };
          } catch (failure) {
            try { if ((await journal.get(id)).phase !== 'closed') await journal.retain(id); }
            catch (recordError) { throw new RepositoryPreparationCleanupError(record.allocation, failure, recordError); }
            throw failure;
          }
        });
      };
      this.withLifecycleLease = async (request, operation, operationOptions) => {
        checkAbort(operationOptions);
        validateIdentifier(request.runId);
        const config = this.byName.get(request.repository.url);
        if (!config || (request.repository.ref !== undefined && request.repository.ref !== config.baseBranch)) {
          throw new Error('repository/ref is not configured for lifecycle');
        }
        return leases.run([config.leaseKey!], async () => {
          checkAbort(operationOptions);
          return operation();
        });
      };
      this.lifecycle = new ConfiguredRepositoryLifecycle({
        repositories: [...this.byName.values()].map(config => ({ url: config.name, ref: config.baseBranch })),
        operations: ['prepare', 'checkout', 'publish', 'cleanup'],
      }, async (operation, input, workspace, operationOptions, onAllocation) => {
        const repository = workspace?.repository ?? (input as RepositoryPrepareRequest).repository;
        const config = this.byName.get(repository.url)!;
        let preparationFailure: { error: unknown } | undefined;
        return leases.run([config.leaseKey!], async () => {
          checkAbort(operationOptions);
          if (operation === 'prepare') {
            try {
            await fs.mkdir(root, { recursive: true });
            const parent = await fs.realpath(root);
            const id = randomUUID();
            const path = join(parent, id);
            const allocation = { id, repository, runId: (input as RepositoryPrepareRequest).runId, path };
            await journal.begin(allocation, config.leaseKey!, recoveryConfiguration(config));
            let reserved = false;
            let directoryIdentity: { dev: number; ino: number } | undefined;
            const identity = async () => {
              const directory = await fs.lstat(path);
              const marker = await fs.lstat(join(path, '.git'));
              if (!directory.isDirectory() || directory.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink()) {
                throw new Error('refusing replaced repository allocation');
              }
              if (directory.dev !== directoryIdentity?.dev || directory.ino !== directoryIdentity.ino) {
                throw new Error('refusing replaced repository allocation');
              }
              return JSON.stringify([directory.dev, directory.ino, marker.dev, marker.ino, await fs.readFile(join(path, '.git'), 'utf8')]);
            };
            let allocatedIdentity: string | undefined;
            onAllocation?.(async failure => {
              try {
                await leases.run([config.leaseKey!], async () => {
                  await journal.bindOwner(id);
                  const directory = await fs.lstat(path).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                    throw error;
                  });
                  if (!directory) {
                    if (reserved) throw new Error('repository allocation disappeared before cleanup');
                    await journal.close(id);
                    return;
                  }
                  if (!allocatedIdentity && directoryIdentity && directory.dev === directoryIdentity.dev && directory.ino === directoryIdentity.ino
                    && directory.isDirectory() && !directory.isSymbolicLink() && (await fs.readdir(path)).length === 0) {
                    await journal.removeReservation(id);
                    return;
                  }
                  const beforeRemove = async () => {
                    if (!allocatedIdentity || await identity() !== allocatedIdentity || await fs.realpath(path) !== path
                      || await fs.realpath(root) !== parent) throw new Error('refusing replaced repository allocation');
                    if (!await store.ownsCheckout(path)) throw new Error('refusing unowned repository allocation');
                    await journal.removing(id);
                  };
                  if (store.removeCheckout) {
                    await store.removeCheckout(path, { force: false, beforeRemove });
                  } else {
                    await store.withCheckoutLock(path, async () => {
                      await beforeRemove();
                      if ((await this.run(path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])).stdout.trim()) {
                        throw new Error('refusing cleanup of dirty repository allocation');
                      }
                      const entries = (await this.run(path, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0');
                      if (entries.some(entry => entry.startsWith(`worktree ${path}${sep}`))) throw new Error('refusing workspace with nested worktrees');
                      await beforeRemove();
                      await this.run(path, ['worktree', 'remove', path]);
                    });
                  }
                  await journal.close(id);
                });
              } catch (cleanupError) {
                try { if ((await journal.get(id)).phase !== 'closed') await journal.retain(id); }
                catch (recordError) { throw new RepositoryPreparationCleanupError(allocation, failure, new AggregateError([cleanupError, recordError], 'Repository cleanup and recovery record update failed')); }
                throw new RepositoryPreparationCleanupError(allocation, failure, cleanupError);
              }
            });
            await fs.mkdir(path);
            reserved = true;
            directoryIdentity = await fs.lstat(path);
            await journal.reserved(id);
            await store.ensureCheckout(config.remoteUrl!, path, config.baseBranch!);
            allocatedIdentity = await identity();
            await journal.owned(id);
            return { ...allocation, snapshot: await this.snapshotPath(path, operationOptions) };
            } catch (error) {
              preparationFailure = { error };
              throw error;
            }
          }
          await journal.bindOwner(workspace!.id);
          const path = workspace!.path!;
          const realPath = await fs.realpath(path);
          if (realPath !== path || !realPath.startsWith(`${await fs.realpath(root)}${sep}`)) throw new Error('refusing relocated repository workspace');
          if (!await store.ownsCheckout(path)) throw new Error('refusing unowned repository workspace');
          return store.withCheckoutLock(path, async () => {
            checkAbort(operationOptions);
            if (operation === 'snapshot') return this.snapshotPath(path, operationOptions);
            if (operation === 'checkout') {
              const branch = input.branch!;
              let commit = workspace!.snapshot.commit;
              const current = await this.snapshotPath(path, operationOptions);
              if (current.dirty || current.commit !== commit || current.branch !== workspace!.snapshot.branch) throw new Error('repository workspace changed before checkout');
              if (input.ref !== undefined) {
                await this.assertPushDestination(path, config.remoteUrl!, operationOptions);
                await this.run(path, ['-c', 'http.followRedirects=false', 'fetch', '--no-tags', '--no-recurse-submodules', '--',
                  config.remoteUrl!, `refs/heads/${input.ref}`], operationOptions);
                commit = (await this.run(path, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], operationOptions)).stdout.trim();
                if (!/^[a-f0-9]{7,64}$/i.test(commit)) throw new Error('invalid repository checkout source commit');
              }
              const existing = (await this.run(path, ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`], operationOptions)).stdout.trim();
              if (existing && existing !== commit) throw new Error('repository checkout target revision conflicts with requested source');
              await this.run(path, existing ? ['switch', branch] : ['switch', '-c', branch, commit], operationOptions);
              const snapshot = await this.snapshotPath(path, operationOptions);
              if (snapshot.commit !== commit || snapshot.branch !== branch) throw new Error('repository checkout differs from requested revision or branch');
              return { ...workspace, snapshot };
            }
            const current = await this.snapshotPath(path, operationOptions);
            if (current.dirty || current.commit !== input.expectedCommit || current.branch !== input.expectedBranch) throw new Error('repository workspace changed before operation');
            if (operation === 'publish') {
              if (current.branch !== workspace!.snapshot.branch) throw new Error('refusing to publish an unowned branch');
              await this.assertPushDestination(path, config.remoteUrl!, operationOptions);
              await this.run(path, ['-c', 'http.followRedirects=false', 'push', '--no-follow-tags', '--recurse-submodules=no', '--',
                config.remoteUrl!, `${current.commit}:refs/heads/${current.branch}`], operationOptions);
              await journal.published(workspace!.id, current.commit);
              return { branch: current.branch, commit: current.commit };
            }
            const worktrees = (await this.run(path, ['worktree', 'list', '--porcelain', '-z'], operationOptions)).stdout.split('\0');
            if (worktrees.some(entry => entry.startsWith(`worktree ${realPath}${sep}`))) throw new Error('refusing workspace with nested worktrees');
            await journal.assertIdentity(await journal.get(workspace!.id));
            await journal.removing(workspace!.id);
            await this.run(path, ['worktree', 'remove', path], operationOptions);
            await journal.close(workspace!.id);
            return { removed: true };
          }).catch(async failure => {
            const record = await journal.get(workspace!.id);
            if (record.phase === 'removing') await journal.retain(workspace!.id);
            throw failure;
          });
        }).catch(error => {
          if (preparationFailure && preparationFailure.error !== error) {
            throw new AggregateError([preparationFailure.error, error], 'repository preparation and lease release failed', { cause: preparationFailure.error });
          }
          throw error;
        });
      }, true, nativeWorkspace ? workspaceIdentity : undefined);
      this.capabilities = { ...this.lifecycle.capabilities, clone: true, push: true, recovery: true };
      if (nativeWorkspace) {
        this.withWorkspaceLease = (request, operation, operationOptions) => requireLifecycle(this.lifecycle).withWorkspace(request, operationOptions, async owned => {
          if (!isAbsolute(request.path) || request.path !== owned.workspace.path || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.expectedCommit)) {
            throw new Error('repository workspace binding changed');
          }
          const config = this.byName.get(owned.workspace.repository.url)!;
          const [platform, ...project] = config.leaseKey!.split(':');
          return leases.run([config.leaseKey!], () => withWorkspaceOwnershipAvailable(request.path,
            [{ platform, projectKey: project.join(':') }], () => store.withCheckoutLock(request.path, async () => {
              checkAbort(operationOptions);
              if (!await store.ownsCheckout(request.path) || workspaceIdentity(request.path) !== owned.identity) throw new Error('repository workspace ownership changed');
              const claimIds = repositoryClaimIds();
              if (!claimIds.length) throw new Error('repository workspace lease unavailable');
              const within = AsyncLocalStorage.snapshot();
              let closed = false;
              const readSnapshot = () => {
                checkAbort(operationOptions);
                if (closed) throw new Error('repository workspace lease is closed');
                if (JSON.stringify(within(repositoryClaimIds)) !== JSON.stringify(claimIds)
                  || workspaceIdentity(request.path) !== owned.identity) throw new Error('repository workspace lease changed');
                const snapshot = nativeWorkspaceSnapshot(request.path, operationOptions);
                if (snapshot.dirty || snapshot.commit !== request.expectedCommit || snapshot.branch !== owned.workspace.snapshot.branch) throw new Error('repository workspace changed');
                return snapshot;
              };
              const snapshot = readSnapshot();
              const lease = Object.freeze({
                workspace: Object.freeze({ ...owned.workspace, repository: Object.freeze({ ...owned.workspace.repository }), snapshot: Object.freeze(snapshot) }),
                leaseId: createHash('sha256').update(JSON.stringify(claimIds)).digest('hex'), readSnapshot,
              });
              nativeWorkspaceLeases.add(lease);
              try { return await operation(lease); } finally { closed = true; }
            })));
        });
      }
    }
  }

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    checkAbort(options);
    assertCurrentWorkspace(repository);
    const config = this.lookup(repository);
    return this.snapshotPath(config.path, options);
  }

  async listRecoveryAllocations(): Promise<RepositoryRecoveryRecord[]> {
    if (!this.recovery) throw new Error('Repository recovery requires managed lifecycle');
    return this.recovery.list();
  }

  async recoverAllocation(id: string): Promise<RepositoryCleanupResult> {
    if (!this.recover) throw new Error('Repository recovery requires managed lifecycle');
    return this.recover(id);
  }

  private async snapshotPath(path: string, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    const commit = (await this.run(path, ['rev-parse', 'HEAD'], options)).stdout.trim();
    if (!commit) throw new Error('repository has no HEAD commit');
    const branch = (await this.run(path, ['rev-parse', '--abbrev-ref', 'HEAD'], options)).stdout.trim();
    const status = (await this.run(path, ['status', '--porcelain', '--untracked-files=all', '--ignored'], options)).stdout;
    return { commit, branch: branch || 'HEAD', dirty: status.trim().length > 0 };
  }

  private async assertPushDestination(path: string, remoteUrl: string, options?: ProviderOperationOptions): Promise<void> {
    const configuration = (await this.run(path, ['config', '--null', '--list'], options)).stdout.split('\0');
    for (const entry of configuration) {
      const separator = entry.indexOf('\n');
      if (separator !== -1 && /^url\..*\.(insteadof|pushinsteadof)$/i.test(entry.slice(0, separator))
        && remoteUrl.startsWith(entry.slice(separator + 1))) throw new Error('repository URL rewrite is not permitted');
    }
    const configuredOrigins = configuration.filter(entry => entry.startsWith('remote.origin.url\n'));
    if (configuredOrigins.length !== 1 || configuredOrigins[0] !== `remote.origin.url\n${remoteUrl}`) throw new Error('repository origin changed');
    const configuredPushUrls = configuration.filter(entry => entry.startsWith('remote.origin.pushurl\n'));
    if (configuredPushUrls.length > 1 || (configuredPushUrls.length === 1 && configuredPushUrls[0] !== `remote.origin.pushurl\n${remoteUrl}`)) {
      throw new Error('repository push destination changed');
    }
    const origins = (await this.run(path, ['remote', 'get-url', '--all', 'origin'], options)).stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    if (origins.length !== 1 || origins[0] !== remoteUrl) throw new Error('repository origin changed');
    const destinations = (await this.run(path, ['remote', 'get-url', '--push', '--all', 'origin'], options)).stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    if (destinations.length !== 1 || destinations[0] !== remoteUrl) throw new Error('repository push destination changed');
  }

  async prepare(request: RepositoryPrepareRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).prepare(request, options);
  }

  async checkout(request: RepositoryCheckoutRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).checkout(request, options);
  }

  async publish(request: RepositoryPublishRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
    return requireLifecycle(this.lifecycle).publish(request, options);
  }

  async cleanup(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryCleanupResult> {
    return requireLifecycle(this.lifecycle).cleanup(request, options);
  }

  private lookup(repository: RepositoryRef): LocalRepositoryConfig {
    const byName = this.byName.get(repository.url);
    if (byName) return byName;
    const byPath = [...this.byName.values()].find(config => config.path === repository.url);
    if (byPath) return byPath;
    throw new Error('repository is not configured for snapshot');
  }

  private async run(cwd: string, args: readonly string[], options?: ProviderOperationOptions): Promise<CommandResult> {
    return runRepositoryCommand(this.git, { command: 'git', args, cwd, signal: options?.signal, deadlineAt: options?.deadlineAt });
  }
}

// --- Remote workspace (HTTP workspace API) ---

export interface RemoteWorkspaceProviderOptions {
  /** Base URL of the workspace API, e.g. `https://workspace.example/api`. */
  readonly baseUrl: string;
  /** Optional transport; defaults to global fetch at operation time. */
  readonly transport?: FetchTransport;
  /** Optional bearer token sent as an Authorization header. */
  readonly token?: OperationSecret;
  readonly lifecycle?: RepositoryLifecycleConfig;
  readonly managed?: { workspaceRoot: string; repositories: readonly MountedRepository[] };
}

interface MountedRepository { name: string; gitDirectory: string; leaseKey: string; remoteUrl: string }
interface MountedLease { runId: string; repository: MountedRepository; path: string; common: string; active: boolean; identity?: string }

/**
 * Snapshots a remote workspace through its HTTP API. `repository.url` carries
 * the workspace identifier. The JSON response is validated before it is trusted.
 */
export class RemoteWorkspaceProvider implements RepositoryProvider {
  readonly id = 'remote-workspace';
  readonly capabilities: RepositoryProvider['capabilities'];
  private readonly lifecycle?: ConfiguredRepositoryLifecycle;
  private readonly lifetime = new AbortController();
  readonly withLifecycleLease?: RepositoryProvider['withLifecycleLease'];
  private readonly mounted = new AsyncLocalStorage<MountedLease>();

  constructor(private readonly options: RemoteWorkspaceProviderOptions) {
    const leases = options.managed && new RepositoryLeases();
    if (options.managed) {
      const { workspaceRoot, repositories } = options.managed;
      const configured = new Map(repositories.map(repo => [repo.name, repo]));
      if (!isAbsolute(workspaceRoot) || !options.lifecycle || configured.size !== repositories.length || configured.size !== options.lifecycle.repositories.length) throw new Error('Invalid managed workspace configuration');
      for (const { url, ref } of options.lifecycle.repositories) {
        validateIdentifier(url);
        const repo = configured.get(url);
        if (!ref || !repo || !isAbsolute(repo.gitDirectory) || !/^(github|gitlab):[a-zA-Z0-9_./:-]+$/.test(repo.leaseKey)) throw new Error('Missing trusted repository mount or lease key');
        validateRemoteUrl(repo.remoteUrl);
      }
      this.withLifecycleLease = async (request, operation, operationOptions) => {
        checkAbort(operationOptions);
        validateIdentifier(request.runId);
        const repository = configured.get(request.repository.url);
        if (!repository || !options.lifecycle!.repositories.some(ref => ref.url === repository.name && (!request.repository.ref || ref.ref === request.repository.ref))) throw new Error('repository/ref is not configured for lifecycle');
        return leases!.run([repository.leaseKey], async () => {
          checkAbort(operationOptions);
          const lease: MountedLease = { repository, runId: request.runId, common: await fs.realpath(repository.gitDirectory), path: join(workspaceRoot, `${repository.name}@${request.runId}`), active: true };
          try { return await this.mounted.run(lease, operation); } finally { lease.active = false; }
        });
      };
    }
    if (options.lifecycle) {
      this.lifecycle = new ConfiguredRepositoryLifecycle(options.lifecycle, async (operation, input, workspace, operationOptions) => {
        const repository = workspace?.repository ?? (input as RepositoryPrepareRequest).repository;
        const route = workspace ? `sessions/${encodeURIComponent(workspace.id)}/${operation}` : operation;
        const send = () => this.request(repository.url, route, operation === 'snapshot' ? undefined : input, operationOptions);
        if (!leases) return send();
        const lease = this.mounted.getStore();
        if (!lease?.active || lease.repository.name !== repository.url || lease.runId !== (workspace?.runId ?? (input as RepositoryPrepareRequest).runId)) throw new Error('Managed workspace requires its active repository lease');
        if (workspace && !lease.identity) throw new Error('Workspace was not prepared under this lease');
        return leases.run([lease.repository.leaseKey], () => this.mountedOperation(lease, operation, input, workspace, send, operationOptions));
      }, !!options.managed);
    }
    this.capabilities = this.lifecycle?.capabilities ?? SNAPSHOT_ONLY;
  }

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    assertCurrentWorkspace(repository);
    return validateSnapshot(await this.request(repository.url, 'snapshot', undefined, options));
  }

  async prepare(request: RepositoryPrepareRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return this.operate(() => requireLifecycle(this.lifecycle).prepare(request, options), options);
  }

  async checkout(request: RepositoryCheckoutRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return this.operate(() => requireLifecycle(this.lifecycle).checkout(request, options), options);
  }

  async publish(request: RepositoryPublishRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
    return this.operate(() => requireLifecycle(this.lifecycle).publish(request, options), options);
  }

  async cleanup(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryCleanupResult> {
    return this.operate(() => requireLifecycle(this.lifecycle).cleanup(request, options), options);
  }

  dispose(): void { this.lifetime.abort(); }

  private async mountedOperation(lease: MountedLease, operation: RepositoryLifecycleOperation | 'snapshot', input: LifecycleInput,
    workspace: RepositoryWorkspace | undefined, send: () => Promise<unknown>, options?: ProviderOperationOptions): Promise<unknown> {
    const { path, repository } = lease;
    const inspect = () => {
      const identity = workspaceIdentity(path);
      if (lease.identity !== undefined && lease.identity !== identity) throw new Error('Mounted checkout identity changed');
      const read = nativeWorkspaceReader(path, options);
      const common = realpathSync(read(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
      const admin = realpathSync(read(['rev-parse', '--absolute-git-dir']).trim());
      if (common !== lease.common || dirname(admin) !== join(common, 'worktrees')) throw new Error('Mounted checkout belongs to another repository');
      const backlink = readFileSync(join(admin, 'gitdir'), 'utf8').trimEnd();
      if (realpathSync(resolve(admin, backlink)) !== join(path, '.git')) throw new Error('Mounted checkout registration changed');
      for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
        if (read(args).trimEnd() !== repository.remoteUrl) throw new Error('Mounted repository origin or push destination changed');
      }
      const state = nativeWorkspaceSnapshot(path, options);
      if (state.dirty) throw new Error('refusing operation on dirty repository workspace');
      return { identity, state, read };
    };
    if (operation === 'prepare') {
      if (await fs.realpath(this.options.managed!.workspaceRoot) !== this.options.managed!.workspaceRoot || await fs.lstat(path).then(() => true, missingPath)) throw new Error('Managed workspace path unavailable');
    } else {
      const { state } = inspect();
      if (!workspace || state.branch !== workspace.snapshot.branch || (operation === 'checkout' && state.commit !== workspace.snapshot.commit)
        || (input.expectedCommit !== undefined && (state.commit !== input.expectedCommit || state.branch !== input.expectedBranch))) throw new Error('Mounted checkout revision changed');
    }
    const payload = record(await send());
    if (operation === 'cleanup') {
      if (payload.removed === true && await fs.lstat(path).then(() => true, missingPath)) throw new Error('Workspace cleanup left the mounted checkout in place');
      return payload;
    }
    const { state, identity, read } = inspect();
    const isWorkspace = operation === 'prepare' || operation === 'checkout';
    const reported = isWorkspace ? record(payload.snapshot) : payload;
    if (reported.branch !== state.branch || reported.commit !== state.commit || (operation !== 'publish' && reported.dirty !== state.dirty)) throw new Error('Workspace response differs from mounted checkout');
    if (!isWorkspace) return payload;
    if (payload.path !== undefined && payload.path !== path) throw new Error('Workspace response conflicts with trusted mount');
    const ref = operation === 'prepare' ? (input as RepositoryPrepareRequest).repository.ref : input.ref;
    if (ref && read(['rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`]).trim() !== state.commit) throw new Error('Mounted checkout differs from configured source ref');
    lease.identity = identity;
    return { ...payload, path };
  }

  private async operate<Result>(operation: () => Promise<Result>, options?: ProviderOperationOptions): Promise<Result> {
    try { return await operation(); }
    catch (error) {
      if (this.options.token !== undefined && options?.signal?.aborted) throw new Error('Workspace request cancelled or interrupted');
      throw error;
    }
  }

  private async request(repository: string, route: string, input: unknown, options?: ProviderOperationOptions): Promise<unknown> {
    if (this.lifetime.signal.aborted || (this.options.token !== undefined && options?.signal?.aborted)) throw new Error('Operation credential unavailable');
    checkAbort(options);
    // `repository` is an encoded URL path segment, not a lifecycle identifier:
    // names such as "team/repo with space" are part of the snapshot contract.
    // Still refuse traversal, encoded dot segments and credential/URL forms.
    if (typeof repository !== 'string' || repository.length === 0 || repository.length > 512
      || /[\0\r\n]/.test(repository) || repository.includes('://') || /%2e/i.test(repository)
      || repository.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new Error('invalid workspace repository identifier');
    }
    let base: URL;
    try { base = new URL(this.options.baseUrl); } catch { throw new Error('invalid workspace API base URL'); }
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('invalid workspace API base URL');
    }
    if (this.options.token !== undefined && base.protocol !== 'https:') throw new Error('workspace bearer token requires HTTPS');
    const workspace = encodeURIComponent(repository);
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/workspaces/${workspace}/${route}`;
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Workspace request interrupted'));
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    let deadlineAt = Math.min(Date.now() + 15_000, options?.deadlineAt ?? Infinity);
    try {
      const credential = this.options.token === undefined ? undefined : await resolveOperationCredential(this.options.token, { signal, deadlineAt });
      if (credential?.expiresAt !== undefined) deadlineAt = Math.min(deadlineAt, Date.parse(credential.expiresAt));
      checkAbort({ signal, deadlineAt });
      const response = await requestHttp(
        this.options.transport,
        url,
        {
          method: input === undefined ? 'GET' : 'POST',
          headers: { ...(credential ? { authorization: `Bearer ${credential.secret}` } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        },
        { signal, deadlineAt },
      );
      const result = await this.parseJson(response);
      checkAbort({ signal, deadlineAt });
      if (credential) validateOperationCredential(credential);
      return result;
    } catch (error) {
      if (signal.aborted || deadlineAt <= Date.now()) throw new Error('Workspace request interrupted');
      throw error;
    } finally {
      options?.signal?.removeEventListener('abort', abort);
    }
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('workspace API returned invalid JSON');
    }
  }
}

// --- Special git backend via an injectable snapshot command ---

export interface SpecialGitBackendProviderOptions {
  /** Backend executable implementing `snapshot --json <repository> [--ref <ref>]`. */
  readonly backend: string;
  /** Defaults to the real process via {@link executeCommand}. */
  readonly executor?: CommandExecutor;
  readonly lifecycle?: RepositoryLifecycleConfig;
}

/**
 * Snapshots through a specialised git backend command that answers with a JSON
 * snapshot document. The backend command itself is injected so this stays
 * offline and deterministic under test.
 */
export class SpecialGitBackendProvider implements RepositoryProvider {
  readonly id = 'special-git-backend';
  readonly capabilities: RepositoryProvider['capabilities'];
  private readonly lifecycle?: ConfiguredRepositoryLifecycle;

  private readonly executor: CommandExecutor;

  constructor(private readonly options: SpecialGitBackendProviderOptions) {
    this.executor = options.executor ?? executeCommand;
    if (options.lifecycle) {
      this.lifecycle = new ConfiguredRepositoryLifecycle(options.lifecycle, async (operation, input, workspace, operationOptions) => {
        checkAbort(operationOptions);
        const result = await runRepositoryCommand(this.executor, { command: this.options.backend, args: [operation, '--json'],
          input: JSON.stringify({ ...input, ...(workspace ? { repository: workspace.repository, workspaceId: workspace.id } : {}) }),
          signal: operationOptions?.signal, deadlineAt: operationOptions?.deadlineAt }, 'special git backend lifecycle command failed');
        checkAbort(operationOptions);
        try { return JSON.parse(result.stdout) as unknown; } catch { throw new Error('special git backend returned invalid JSON'); }
      });
    }
    this.capabilities = this.lifecycle?.capabilities ?? SNAPSHOT_ONLY;
  }

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    checkAbort(options);
    // A backend repository may be an absolute local path or a remote URL; it is
    // passed as one argv element, so reject option injection, control bytes and
    // traversal while keeping the original path/URL contract. Lifecycle
    // identifiers themselves are validated separately.
    if (!repository.url || repository.url.startsWith('-') || repository.url.length > 4096
      || /[\0\r\n]/.test(repository.url)) {
      throw new Error('invalid backend repository identifier');
    }
    if (repository.ref?.startsWith('-')) throw new Error('invalid backend repository ref');
    if (repository.url.includes('://')) validateRemoteUrl(repository.url);
    else if (/%2e/i.test(repository.url) || repository.url.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new Error('invalid backend repository identifier');
    }
    if (repository.ref !== undefined) validateBranch(repository.ref);
    const args = ['snapshot', '--json', repository.url];
    if (repository.ref) args.push('--ref', repository.ref);
    const result = await runRepositoryCommand(this.executor, { command: this.options.backend, args, signal: options?.signal,
      deadlineAt: options?.deadlineAt }, 'special git backend snapshot command failed');
    checkAbort(options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error('special git backend returned invalid JSON');
    }
    return validateSnapshot(parsed);
  }

  async prepare(request: RepositoryPrepareRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).prepare(request, options);
  }

  async checkout(request: RepositoryCheckoutRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).checkout(request, options);
  }

  async publish(request: RepositoryPublishRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
    return requireLifecycle(this.lifecycle).publish(request, options);
  }

  async cleanup(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryCleanupResult> {
    return requireLifecycle(this.lifecycle).cleanup(request, options);
  }
}

function assertCurrentWorkspace(repository: RepositoryRef): void {
  if (!repository.url.trim()) throw new Error('repository identifier is required');
  if (repository.ref !== undefined) throw new Error('snapshot of a specific ref is not supported by this workspace provider');
}

export interface RepositoryLifecycleConfig {
  readonly repositories: readonly RepositoryRef[];
  readonly operations: readonly RepositoryLifecycleOperation[];
}

type LifecycleInput = (RepositoryPrepareRequest | RepositoryWorkspaceRequest) & {
  readonly expectedCommit?: string;
  readonly expectedBranch?: string;
  readonly branch?: string;
  readonly ref?: string;
  readonly merge?: false;
};
type LifecycleRequest = (operation: RepositoryLifecycleOperation | 'snapshot', input: LifecycleInput,
  workspace: RepositoryWorkspace | undefined, options?: ProviderOperationOptions,
  onAllocation?: (rollback: (failure: unknown) => Promise<void>) => void) => Promise<unknown>;
type OwnedWorkspace = { workspace: RepositoryWorkspace; checkout: boolean; safeCommit: string; busy: boolean; identity?: string };

class ConfiguredRepositoryLifecycle {
  readonly capabilities: RepositoryProvider['capabilities'];
  private readonly repositories: readonly RepositoryRef[];
  private readonly owned = new Map<string, OwnedWorkspace>();
  private readonly preparing = new Set<string>();

  constructor(config: RepositoryLifecycleConfig, private readonly request: LifecycleRequest, private readonly localPaths = false,
    private readonly identify?: (path: string) => string) {
    this.repositories = config.repositories.map(repository => {
      validateIdentifier(repository.url);
      if (repository.ref !== undefined) validateBranch(repository.ref);
      return { ...repository };
    });
    if (new Set(this.repositories.map(repository => repository.url)).size !== this.repositories.length) throw new Error('duplicate lifecycle repository');
    const operations = new Set(config.operations);
    if ([...operations].some(operation => !['prepare', 'checkout', 'publish', 'cleanup'].includes(operation))) throw new Error('invalid repository lifecycle operation');
    if (operations.size && !operations.has('prepare')) throw new Error('repository lifecycle requires prepare');
    if (operations.has('publish') && !operations.has('checkout')) throw new Error('repository publication requires checkout');
    this.capabilities = Object.freeze({ ...SNAPSHOT_ONLY,
      prepare: operations.has('prepare'), checkout: operations.has('checkout'),
      publish: operations.has('publish'), cleanup: operations.has('cleanup') });
  }

  async prepare(input: RepositoryPrepareRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    this.assertSupported('prepare', options);
    validateIdentifier(input.runId);
    const repository = this.repositories.find(config => config.url === input.repository.url
      && (input.repository.ref === undefined || config.ref === input.repository.ref));
    if (!repository) throw new Error('repository/ref is not configured for lifecycle');
    const key = JSON.stringify([repository.url, input.runId]);
    if (this.preparing.has(key) || [...this.owned.values()].some(entry => entry.workspace.repository.url === repository.url && entry.workspace.runId === input.runId)) {
      throw new Error('repository workspace already prepared for this run');
    }
    this.preparing.add(key);
    let rollback: ((failure: unknown) => Promise<void>) | undefined;
    let workspace: RepositoryWorkspace | undefined;
    try {
      const request = { repository, runId: input.runId };
      workspace = validateWorkspace(await this.request('prepare', request, undefined, options, release => { rollback = release; }), request, this.localPaths);
      if (this.owned.has(workspace.id)) throw new Error('repository workspace response reused an owned identifier');
      this.owned.set(workspace.id, { workspace, checkout: false, safeCommit: workspace.snapshot.commit, busy: false,
        ...(this.identify ? { identity: this.identify(workspace.path!) } : {}) });
      checkAbort(options);
      return workspace;
    } catch (error) {
      if (rollback) {
        await rollback(error);
        if (workspace && this.owned.get(workspace.id)?.workspace === workspace) this.owned.delete(workspace.id);
      }
      throw error;
    } finally { this.preparing.delete(key); }
  }

  checkout(input: RepositoryCheckoutRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return this.use('checkout', input, options, async owned => {
      if (owned.checkout) throw new Error('repository workspace already checked out');
      const branch = input.branch ?? `afk/${owned.workspace.runId}`;
      const ref = input.ref;
      validateBranch(branch);
      if (ref !== undefined) validateBranch(ref);
      if (branch === owned.workspace.repository.ref) throw new Error('repository checkout cannot target the configured base branch');
      const workspace = validateWorkspace(await this.request('checkout', { workspaceId: owned.workspace.id, branch, ...(ref === undefined ? {} : { ref }) }, owned.workspace, options), owned.workspace, this.localPaths);
      if (workspace.id !== owned.workspace.id) throw new Error('repository checkout changed workspace identity');
      if (workspace.path !== owned.workspace.path || workspace.snapshot.branch !== branch) throw new Error('repository checkout did not create the run branch');
      if (ref === undefined && workspace.snapshot.commit !== owned.workspace.snapshot.commit) throw new Error('repository checkout changed the prepared revision');
      owned.workspace = workspace;
      owned.checkout = true;
      owned.safeCommit = workspace.snapshot.commit;
      return workspace;
    });
  }

  publish(input: RepositoryPublishRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
    return this.use('publish', input, options, async owned => {
      if (!owned.checkout) throw new Error('repository workspace must be checked out before publication');
      const snapshot = await this.cleanSnapshot(owned, options);
      if (input.expectedCommit !== undefined && snapshot.commit !== input.expectedCommit) throw new Error('Repository workspace differs from the verified commit');
      const result = record(await this.request('publish', { workspaceId: owned.workspace.id, expectedCommit: snapshot.commit, expectedBranch: snapshot.branch, merge: false }, owned.workspace, options));
      const publication = validateLifecycleSnapshot({ ...result, dirty: false });
      if (publication.commit !== snapshot.commit || publication.branch !== snapshot.branch) throw new Error('repository publication does not match workspace');
      if (result.url !== undefined) validateRemoteUrl(result.url);
      owned.safeCommit = publication.commit;
      return { commit: publication.commit, branch: publication.branch, ...(typeof result.url === 'string' ? { url: result.url } : {}) };
    });
  }

  cleanup(input: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryCleanupResult> {
    return this.use('cleanup', input, options, async owned => {
      const snapshot = await this.cleanSnapshot(owned, options);
      if (snapshot.commit !== owned.safeCommit) throw new Error('refusing cleanup of unpublished repository work');
      const result = record(await this.request('cleanup', { workspaceId: owned.workspace.id, expectedCommit: snapshot.commit, expectedBranch: snapshot.branch }, owned.workspace, options));
      if (typeof result.removed !== 'boolean') throw new Error('invalid repository cleanup response');
      if (result.removed) this.owned.delete(owned.workspace.id);
      return { removed: result.removed };
    });
  }

  private async cleanSnapshot(owned: OwnedWorkspace, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    const snapshot = validateLifecycleSnapshot(await this.request('snapshot', { workspaceId: owned.workspace.id }, owned.workspace, options));
    checkAbort(options);
    if (snapshot.dirty) throw new Error('refusing operation on dirty repository workspace');
    if (snapshot.branch !== owned.workspace.snapshot.branch) throw new Error('repository workspace branch changed');
    return snapshot;
  }

  private async use<Result>(operation: RepositoryLifecycleOperation, input: RepositoryWorkspaceRequest, options: ProviderOperationOptions | undefined,
    execute: (owned: OwnedWorkspace) => Promise<Result>): Promise<Result> {
    this.assertSupported(operation, options);
    return this.withWorkspace(input, options, execute);
  }

  async withWorkspace<Result>(input: RepositoryWorkspaceRequest, options: ProviderOperationOptions | undefined,
    execute: (owned: OwnedWorkspace) => Promise<Result>): Promise<Result> {
    checkAbort(options);
    validateIdentifier(input.workspaceId);
    const owned = this.owned.get(input.workspaceId);
    if (!owned) throw new Error('refusing unowned repository workspace');
    if (owned.busy) throw new Error('repository workspace operation already in progress');
    owned.busy = true;
    try {
      const result = await execute(owned);
      checkAbort(options);
      return result;
    } finally { owned.busy = false; }
  }

  private assertSupported(operation: RepositoryLifecycleOperation, options?: ProviderOperationOptions): void {
    checkAbort(options);
    if (!this.capabilities[operation]) throw new Error(`repository lifecycle does not support ${operation}`);
  }
}

function workspaceIdentity(path: string): string {
  if (realpathSync(path) !== path) throw new Error('repository workspace path changed');
  const directory = lstatSync(path);
  const marker = lstatSync(join(path, '.git'));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink() || marker.size > 16 * 1024) throw new Error('repository workspace identity changed');
  return JSON.stringify([directory.dev, directory.ino, marker.dev, marker.ino, readFileSync(join(path, '.git'), 'utf8')]);
}

function missingPath(error: NodeJS.ErrnoException): false {
  if (error.code !== 'ENOENT') throw error;
  return false;
}

function nativeWorkspaceReader(path: string, options?: ProviderOperationOptions) {
  const deadlineAt = Math.min(options?.deadlineAt ?? Infinity, Date.now() + 5000);
  return (args: string[]) => {
    checkAbort(options);
    const timeout = deadlineAt - Date.now();
    if (timeout < 1) throw new Error('repository snapshot deadline exceeded');
    const output = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd: path, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    });
    checkAbort(options);
    if (Date.now() >= deadlineAt) throw new Error('repository snapshot deadline exceeded');
    return output;
  };
}

function nativeWorkspaceSnapshot(path: string, options?: ProviderOperationOptions): RepositorySnapshot {
  const read = nativeWorkspaceReader(path, options);
  if (realpathSync(read(['rev-parse', '--show-toplevel']).trim()) !== path) throw new Error('repository workspace root changed');
  return { commit: read(['rev-parse', 'HEAD']).trim(), branch: read(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    dirty: read(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']).length > 0 };
}

function requireLifecycle(lifecycle: ConfiguredRepositoryLifecycle | undefined): ConfiguredRepositoryLifecycle {
  if (!lifecycle) throw new Error('repository lifecycle is not configured');
  return lifecycle;
}

type LifecycleResponse = {
  readonly dirty?: unknown;
  readonly id?: unknown;
  readonly repository?: unknown;
  readonly runId?: unknown;
  readonly path?: unknown;
  readonly snapshot?: unknown;
  readonly commit?: unknown;
  readonly branch?: unknown;
  readonly url?: unknown;
  readonly ref?: unknown;
  readonly removed?: unknown;
};

function record(payload: unknown): LifecycleResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid repository lifecycle response');
  return payload as LifecycleResponse;
}

function validateIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || value.includes('..')) throw new Error('invalid repository lifecycle identifier');
}

function validateBranch(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,255}$/.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.') || value.split('/').some(segment => segment.endsWith('.lock'))) {
    throw new Error('invalid repository lifecycle ref');
  }
}

function validateRemoteUrl(value: unknown): asserts value is string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); } catch { throw new Error('invalid repository lifecycle URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid repository lifecycle URL');
}

function validateLifecycleSnapshot(payload: unknown): RepositorySnapshot {
  const snapshot = validateSnapshot(payload);
  if (!/^[a-fA-F0-9]{7,64}$/.test(snapshot.commit)) throw new Error('invalid repository lifecycle commit');
  validateBranch(snapshot.branch);
  return snapshot;
}

function validateWorkspace(payload: unknown, expected: RepositoryPrepareRequest, localPaths: boolean): RepositoryWorkspace {
  const value = record(payload);
  validateIdentifier(value.id);
  const repository = record(value.repository);
  if (value.runId !== expected.runId || repository.url !== expected.repository.url || repository.ref !== expected.repository.ref) {
    throw new Error('repository workspace response does not match request');
  }
  if (value.path !== undefined && (!localPaths || typeof value.path !== 'string' || !isAbsolute(value.path) || value.path.includes('\0'))) throw new Error('invalid repository workspace path');
  const snapshot = validateLifecycleSnapshot(value.snapshot);
  if (snapshot.dirty) throw new Error('prepared repository workspace is dirty');
  return Object.freeze({ id: value.id, repository: Object.freeze({ ...expected.repository }), runId: expected.runId,
    snapshot: Object.freeze(snapshot), ...(typeof value.path === 'string' ? { path: value.path } : {}) });
}
