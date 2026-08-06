/**
 * ContainerSandboxProvider — SandboxProvider implementation backed by Docker
 * or Podman. Auto-detects whichever is on PATH and available.
 *
 * Implements the SandboxProvider interface (sandbox/types.ts). createWorktree()
 * still delegates to WorktreeManager (the host-side git operations); create()
 * wraps the worktree in a long-lived container.
 *
 * Isolation level: 'filesystem' (the container's mount namespace is the
 * security boundary; not a full VM).
 *
 * Capabilities: {persistent-filesystem, copy-files, kill-process, interrupt-process,
 * session-transfer}. No 'streaming-exec' yet (Phase 7/8 will add stream-json).
 */

import { WorktreeManager } from '../../core/git';
import { promises as fs } from 'fs';
import type { SandboxProvider, Sandbox, SandboxOptions, SandboxProviderName, IsolationLevel, SandboxCapability, WorktreeInfo } from '../types';
import { DockerContainerProvider } from './docker';
import { PodmanContainerProvider } from './podman';
import { ContainerSandbox } from './sandbox';
import type { ContainerProvider } from './types';
import { EnvVarAllowlist } from './env-allowlist';

const CONTAINER_CAPABILITIES: ReadonlySet<SandboxCapability> = new Set([
  'persistent-filesystem',
  'copy-files',
  'kill-process',
  'interrupt-process',
  'session-transfer',
] as const);

const ISOLATION: IsolationLevel = 'filesystem';

/** Default image + user — overridable per provider instance. */
const DEFAULT_IMAGE = 'afk-sandbox-claude:node22';
const DEFAULT_USER = '1000:1000';

export class ContainerSandboxProvider implements SandboxProvider {
  readonly name: SandboxProviderName = 'docker'; // provider name = engine name for now
  readonly isolation: IsolationLevel = ISOLATION;
  readonly capabilities: ReadonlySet<SandboxCapability> = CONTAINER_CAPABILITIES;

  private readonly worktreeManager: WorktreeManager;
  private readonly provider: ContainerProvider;
  private readonly image: string;
  private readonly user: string;

  constructor(opts?: {
    worktreeManager?: WorktreeManager;
    /** Force a specific container engine. Defaults to first available of docker/podman. */
    provider?: ContainerProvider;
    image?: string;
    user?: string;
  }) {
    this.worktreeManager = opts?.worktreeManager ?? new WorktreeManager();
    this.provider = opts?.provider ?? (globalThis as { __afkContainerProvider?: ContainerProvider }).__afkContainerProvider ?? new DockerContainerProvider();
    this.image = opts?.image ?? (process.env.AFK_SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE);
    this.user = opts?.user ?? DEFAULT_USER;
    this.name = this.provider.engine === 'podman' ? 'podman' : 'docker';
  }

  async createWorktree(options: { iid: number; baseBranch: string }): Promise<WorktreeInfo> {
    const wt = await this.worktreeManager.create(options.iid, options.baseBranch);
    return { iid: wt.iid, path: wt.path, branch: wt.branch };
  }

  async create(options: SandboxOptions): Promise<Sandbox> {
    // Verify the worktree exists.
    try {
      await fs.access(options.worktreePath);
    } catch {
      throw new Error(`ContainerSandboxProvider: worktree does not exist at ${options.worktreePath}`);
    }

    // Verify the engine is available before allocating anything.
    if (!(await this.provider.isAvailable())) {
      throw new Error(
        `ContainerSandboxProvider: container engine '${this.provider.engine}' is not available on PATH`,
      );
    }

    const sandbox = new ContainerSandbox({
      worktreePath: options.worktreePath,
      image: this.image,
      user: this.user,
      extraEnv: containerAgentEnv(options.env ?? process.env),
    });
    sandbox.bindProvider(this.provider);
    await sandbox.createContainer();
    return sandbox;
  }

  /**
   * Auto-detect the first available engine among docker/podman. Useful for
   * sandbox providers that want to prefer one over the other.
   */
  static async detectProvider(): Promise<ContainerProvider | null> {
    const docker = new DockerContainerProvider();
    if (await docker.isAvailable()) return docker;
    const podman = new PodmanContainerProvider();
    if (await podman.isAvailable()) return podman;
    return null;
  }
}

function containerAgentEnv(input: Record<string, string | undefined>): Record<string, string> {
  const source: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined) source[name] = value;
  }
  const filtered = new EnvVarAllowlist().filter(source).allowed;
  // Container defaults must win for host-specific paths and shell identity.
  const excluded = new Set(['HOME', 'PATH', 'SHELL', 'TERM', 'COLORTERM']);
  return Object.fromEntries(
    Object.entries(filtered).filter(([name]) => !excluded.has(name)),
  );
}
