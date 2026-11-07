/**
 * Concrete Repository/Workspace capability providers.
 *
 * These providers expose a single capability: snapshotting the current state of
 * a repository. They deliberately report `clone: false` and `push: false`
 * because none of them can clone or push — a provider must not advertise a
 * capability it does not actually implement.
 *
 * Git access goes through an injectable {@link CommandExecutor} and remote
 * access through an injectable transport or global fetch at operation time.
 * Constructors never perform IO and tests can replace both dependencies.
 */

import type {
  ProviderOperationOptions,
  RepositoryCapability,
  RepositoryProvider,
  RepositoryRef,
  RepositorySnapshot,
} from '../../plugin-sdk/capabilities.js';
import {
  checkAbort,
  executeCommand,
  requestHttp,
  type CommandExecutor,
  type CommandResult,
  type FetchTransport,
} from './dependencies.js';

/** Only snapshot is implemented; never clone/push. */
const SNAPSHOT_ONLY: Readonly<Record<RepositoryCapability, boolean>> = {
  read: true,
  clone: false,
  push: false,
};

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
}

export interface MultiRepositoryProviderOptions {
  readonly repositories: readonly LocalRepositoryConfig[];
  /** Defaults to the real `git` process via {@link executeCommand}. */
  readonly git?: CommandExecutor;
}

/**
 * Snapshots one of a set of pre-configured local repositories by shelling out
 * to `git`. Only the configured set is reachable — an arbitrary path cannot be
 * coaxed into a snapshot.
 */
export class MultiRepositoryProvider implements RepositoryProvider {
  readonly id = 'multi-repository';
  readonly capabilities = SNAPSHOT_ONLY;

  private readonly git: CommandExecutor;
  private readonly byName = new Map<string, LocalRepositoryConfig>();

  constructor(options: MultiRepositoryProviderOptions) {
    this.git = options.git ?? executeCommand;
    for (const config of options.repositories) {
      if (!config.name.trim() || !config.path.trim()) throw new Error('repository name and path are required');
      if (this.byName.has(config.name)) throw new Error(`duplicate repository name: ${config.name}`);
      this.byName.set(config.name, { ...config });
    }
  }

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    checkAbort(options);
    assertCurrentWorkspace(repository);
    const config = this.lookup(repository);
    const commit = (await this.run(config.path, ['rev-parse', 'HEAD'], options)).stdout.trim();
    if (!commit) throw new Error(`repository ${config.name} has no HEAD commit`);
    const branch = (await this.run(config.path, ['rev-parse', '--abbrev-ref', 'HEAD'], options)).stdout.trim();
    const status = (await this.run(config.path, ['status', '--porcelain'], options)).stdout;
    return { commit, branch: branch || 'HEAD', dirty: status.trim().length > 0 };
  }

  private lookup(repository: RepositoryRef): LocalRepositoryConfig {
    const byName = this.byName.get(repository.url);
    if (byName) return byName;
    const byPath = [...this.byName.values()].find(config => config.path === repository.url);
    if (byPath) return byPath;
    throw new Error(`repository is not configured for snapshot: ${repository.url}`);
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
}

/**
 * Snapshots a remote workspace through its HTTP API. `repository.url` carries
 * the workspace identifier. The JSON response is validated before it is trusted.
 */
export class RemoteWorkspaceProvider implements RepositoryProvider {
  readonly id = 'remote-workspace';
  readonly capabilities = SNAPSHOT_ONLY;

  constructor(private readonly options: RemoteWorkspaceProviderOptions) {}

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    checkAbort(options);
    assertCurrentWorkspace(repository);
    const base = new URL(this.options.baseUrl);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('invalid workspace API base URL');
    }
    if (this.options.token && base.protocol !== 'https:') throw new Error('workspace bearer token requires HTTPS');
    const workspace = encodeURIComponent(repository.url);
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/workspaces/${workspace}/snapshot`;
    const response = await requestHttp(
      this.options.transport,
      url,
      {
        method: 'GET',
        headers: this.headers(),
      },
      options,
    );
    const snapshot = validateSnapshot(await this.parseJson(response));
    checkAbort(options);
    return snapshot;
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
}

/**
 * Snapshots through a specialised git backend command that answers with a JSON
 * snapshot document. The backend command itself is injected so this stays
 * offline and deterministic under test.
 */
export class SpecialGitBackendProvider implements RepositoryProvider {
  readonly id = 'special-git-backend';
  readonly capabilities = SNAPSHOT_ONLY;

  private readonly executor: CommandExecutor;

  constructor(private readonly options: SpecialGitBackendProviderOptions) {
    this.executor = options.executor ?? executeCommand;
  }

  async snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot> {
    checkAbort(options);
    if (!repository.url || repository.url.startsWith('-')) throw new Error('invalid backend repository identifier');
    if (repository.ref?.startsWith('-')) throw new Error('invalid backend repository ref');
    const args = ['snapshot', '--json', repository.url];
    if (repository.ref) args.push('--ref', repository.ref);
    const result = await this.executor({
      command: this.options.backend,
      args,
      signal: options?.signal,
    });
    checkAbort(options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error('special git backend returned invalid JSON');
    }
    return validateSnapshot(parsed);
  }
}

function assertCurrentWorkspace(repository: RepositoryRef): void {
  if (!repository.url.trim()) throw new Error('repository identifier is required');
  if (repository.ref !== undefined) throw new Error('snapshot of a specific ref is not supported by this workspace provider');
}
