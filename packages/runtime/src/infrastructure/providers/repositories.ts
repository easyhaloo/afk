import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import type {
  ProviderOperationOptions,
  RepositoryProvider,
  RepositoryRef,
  RepositorySnapshot,
  RepositoryLifecycleOperation,
  RepositoryPrepareRequest,
  RepositoryWorkspaceRequest,
  RepositoryWorkspace,
  RepositoryPublication,
  RepositoryCleanupResult,
} from '../../plugin-sdk/capabilities.js';
import { RepositoryStore } from '../git/repository-store.js';
import { RepositoryLeases } from '../git/repository-lease.js';
import {
  checkAbort,
  executeCommand,
  requestHttp,
  type CommandExecutor,
  type CommandResult,
  type FetchTransport,
} from './dependencies.js';

const SNAPSHOT_ONLY: RepositoryProvider['capabilities'] = Object.freeze({
  read: true,
  clone: false,
  push: false,
});

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

export class MultiRepositoryProvider implements RepositoryProvider {
  readonly id = 'multi-repository';
  readonly capabilities: RepositoryProvider['capabilities'];
  readonly withLifecycleLease?: RepositoryProvider['withLifecycleLease'];

  private readonly git: CommandExecutor;
  private readonly byName = new Map<string, LocalRepositoryConfig>();
  private readonly lifecycle?: ConfiguredRepositoryLifecycle;

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
      const leases = options.managed.leases ?? new RepositoryLeases();
      for (const config of this.byName.values()) {
        validateRemoteUrl(config.remoteUrl);
        validateBranch(config.baseBranch);
        if (!config.leaseKey || !/^(github|gitlab):[a-zA-Z0-9_./:-]+$/.test(config.leaseKey)) throw new Error('managed repository requires a canonical lease key');
      }
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
            const path = join(parent, randomUUID());
            const allocation = { id: randomUUID(), repository, runId: (input as RepositoryPrepareRequest).runId, path };
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
                  const directory = await fs.lstat(path).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                    throw error;
                  });
                  if (!directory) {
                    if (reserved) throw new Error('repository allocation disappeared before cleanup');
                    return;
                  }
                  if (!allocatedIdentity && directoryIdentity && directory.dev === directoryIdentity.dev && directory.ino === directoryIdentity.ino
                    && directory.isDirectory() && !directory.isSymbolicLink() && (await fs.readdir(path)).length === 0) {
                    await fs.rmdir(path);
                    return;
                  }
                  const beforeRemove = async () => {
                    if (!allocatedIdentity || await identity() !== allocatedIdentity || await fs.realpath(path) !== path
                      || await fs.realpath(root) !== parent) throw new Error('refusing replaced repository allocation');
                    if (!await store.ownsCheckout(path)) throw new Error('refusing unowned repository allocation');
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
                });
              } catch (cleanupError) {
                throw new RepositoryPreparationCleanupError(allocation, failure, cleanupError);
              }
            });
            await fs.mkdir(path);
            reserved = true;
            directoryIdentity = await fs.lstat(path);
            await store.ensureCheckout(config.remoteUrl!, path, config.baseBranch!);
            allocatedIdentity = await identity();
            return { ...allocation, snapshot: await this.snapshotPath(path, operationOptions) };
            } catch (error) {
              preparationFailure = { error };
              throw error;
            }
          }
          const path = workspace!.path!;
          const realPath = await fs.realpath(path);
          if (realPath !== path || !realPath.startsWith(`${await fs.realpath(root)}${sep}`)) throw new Error('refusing relocated repository workspace');
          if (!await store.ownsCheckout(path)) throw new Error('refusing unowned repository workspace');
          return store.withCheckoutLock(path, async () => {
            checkAbort(operationOptions);
            if (operation === 'snapshot') return this.snapshotPath(path, operationOptions);
            if (operation === 'checkout') {
              await this.run(path, ['switch', '-c', `afk/${workspace!.runId}`], operationOptions);
              return { ...workspace, snapshot: await this.snapshotPath(path, operationOptions) };
            }
            const current = await this.snapshotPath(path, operationOptions);
            if (current.dirty || current.commit !== input.expectedCommit || current.branch !== input.expectedBranch) throw new Error('repository workspace changed before operation');
            if (operation === 'publish') {
              if (current.branch !== `afk/${workspace!.runId}`) throw new Error('refusing to publish an unowned branch');
              await this.assertPushDestination(path, config.remoteUrl!, operationOptions);
              await this.run(path, ['-c', 'http.followRedirects=false', 'push', '--no-follow-tags', '--recurse-submodules=no', '--',
                config.remoteUrl!, `${current.commit}:refs/heads/${current.branch}`], operationOptions);
              return { branch: current.branch, commit: current.commit };
            }
            const worktrees = (await this.run(path, ['worktree', 'list', '--porcelain', '-z'], operationOptions)).stdout.split('\0');
            if (worktrees.some(entry => entry.startsWith(`worktree ${realPath}${sep}`))) throw new Error('refusing workspace with nested worktrees');
            await this.run(path, ['worktree', 'remove', path], operationOptions);
            return { removed: true };
          });
        }).catch(error => {
          if (preparationFailure && preparationFailure.error !== error) {
            throw new AggregateError([preparationFailure.error, error], 'repository preparation and lease release failed', { cause: preparationFailure.error });
          }
          throw error;
        });
      }, true);
      this.capabilities = { ...this.lifecycle.capabilities, clone: true, push: true };
    }
  }

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    checkAbort(options);
    assertCurrentWorkspace(repository);
    const config = this.lookup(repository);
    return this.snapshotPath(config.path, options);
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

  async checkout(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).checkout(request, options);
  }

  async publish(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
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
    checkAbort(options);
    const result = await this.git({ command: 'git', args, cwd, signal: options?.signal });
    checkAbort(options);
    return result;
  }
}

// --- Remote workspace (HTTP workspace API) ---

export interface RemoteWorkspaceProviderOptions {
  /** Base URL of the workspace API, e.g. `https://workspace.example/api`. */
  readonly baseUrl: string;
  /** Optional transport; defaults to global fetch at operation time. */
  readonly transport?: FetchTransport;
  /** Optional bearer token sent as an Authorization header. */
  readonly token?: string;
  readonly lifecycle?: RepositoryLifecycleConfig;
}

/**
 * Snapshots a remote workspace through its HTTP API. `repository.url` carries
 * the workspace identifier. The JSON response is validated before it is trusted.
 */
export class RemoteWorkspaceProvider implements RepositoryProvider {
  readonly id = 'remote-workspace';
  readonly capabilities: RepositoryProvider['capabilities'];
  private readonly lifecycle?: ConfiguredRepositoryLifecycle;

  constructor(private readonly options: RemoteWorkspaceProviderOptions) {
    if (options.lifecycle) {
      this.lifecycle = new ConfiguredRepositoryLifecycle(options.lifecycle, async (operation, input, workspace, operationOptions) => {
        const repository = workspace?.repository ?? (input as RepositoryPrepareRequest).repository;
        const route = workspace ? `sessions/${encodeURIComponent(workspace.id)}/${operation}` : operation;
        return this.request(repository.url, route, operation === 'snapshot' ? undefined : input, operationOptions);
      });
    }
    this.capabilities = this.lifecycle?.capabilities ?? SNAPSHOT_ONLY;
  }

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    checkAbort(options);
    assertCurrentWorkspace(repository);
    return validateSnapshot(await this.request(repository.url, 'snapshot', undefined, options));
  }

  async prepare(request: RepositoryPrepareRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).prepare(request, options);
  }

  async checkout(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).checkout(request, options);
  }

  async publish(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
    return requireLifecycle(this.lifecycle).publish(request, options);
  }

  async cleanup(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryCleanupResult> {
    return requireLifecycle(this.lifecycle).cleanup(request, options);
  }

  private async request(repository: string, route: string, input: unknown, options?: ProviderOperationOptions): Promise<unknown> {
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
    if (this.options.token && base.protocol !== 'https:') throw new Error('workspace bearer token requires HTTPS');
    const workspace = encodeURIComponent(repository);
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/workspaces/${workspace}/${route}`;
    const response = await requestHttp(
      this.options.transport,
      url,
      {
        method: input === undefined ? 'GET' : 'POST',
        headers: { ...this.headers(), ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      },
      options,
    );
    const result = await this.parseJson(response);
    checkAbort(options);
    return result;
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('workspace API returned invalid JSON');
    }
  }

  private headers(): Record<string, string> {
    return this.options.token ? { authorization: `Bearer ${this.options.token}` } : {};
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
        let result: CommandResult;
        try {
          result = await this.executor({ command: this.options.backend, args: [operation, '--json'],
            input: JSON.stringify({ ...input, ...(workspace ? { repository: workspace.repository, workspaceId: workspace.id } : {}) }), signal: operationOptions?.signal });
        } catch {
          checkAbort(operationOptions);
          throw new Error('special git backend lifecycle command failed');
        }
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
    let result: CommandResult;
    try {
      result = await this.executor({ command: this.options.backend, args, signal: options?.signal });
    } catch {
      checkAbort(options);
      throw new Error('special git backend snapshot command failed');
    }
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

  async checkout(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return requireLifecycle(this.lifecycle).checkout(request, options);
  }

  async publish(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
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
  readonly merge?: false;
};
type LifecycleRequest = (operation: RepositoryLifecycleOperation | 'snapshot', input: LifecycleInput,
  workspace: RepositoryWorkspace | undefined, options?: ProviderOperationOptions,
  onAllocation?: (rollback: (failure: unknown) => Promise<void>) => void) => Promise<unknown>;
type OwnedWorkspace = { workspace: RepositoryWorkspace; checkout: boolean; safeCommit: string; busy: boolean };

class ConfiguredRepositoryLifecycle {
  readonly capabilities: RepositoryProvider['capabilities'];
  private readonly repositories: readonly RepositoryRef[];
  private readonly owned = new Map<string, OwnedWorkspace>();
  private readonly preparing = new Set<string>();

  constructor(config: RepositoryLifecycleConfig, private readonly request: LifecycleRequest, private readonly localPaths = false) {
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
      this.owned.set(workspace.id, { workspace, checkout: false, safeCommit: workspace.snapshot.commit, busy: false });
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

  checkout(input: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace> {
    return this.use('checkout', input, options, async owned => {
      if (owned.checkout) throw new Error('repository workspace already checked out');
      const workspace = validateWorkspace(await this.request('checkout', { workspaceId: owned.workspace.id, branch: `afk/${owned.workspace.runId}` }, owned.workspace, options), owned.workspace, this.localPaths);
      if (workspace.id !== owned.workspace.id) throw new Error('repository checkout changed workspace identity');
      if (workspace.path !== owned.workspace.path || workspace.snapshot.branch !== `afk/${workspace.runId}`) throw new Error('repository checkout did not create the run branch');
      owned.workspace = workspace;
      owned.checkout = true;
      return workspace;
    });
  }

  publish(input: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication> {
    return this.use('publish', input, options, async owned => {
      if (!owned.checkout) throw new Error('repository workspace must be checked out before publication');
      const snapshot = await this.cleanSnapshot(owned, options);
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

function requireLifecycle(lifecycle: ConfiguredRepositoryLifecycle | undefined): ConfiguredRepositoryLifecycle {
  if (!lifecycle) throw new Error('repository lifecycle is not configured');
  return lifecycle;
}

type LifecycleResponse = {
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
