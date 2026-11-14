import { simpleGit, type SimpleGit } from 'simple-git';
import type { BranchHandle, BranchStrategy, BranchStrategyConfig } from '../../domain/branches/types.js';
import type { Sandbox, AgentExecution } from '../../infrastructure/sandbox/types.js';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FilesystemClaimLock, type ClaimLease } from '../../domain/backlog/claim.js';

export type RunOutcomeStatus = 'success' | 'failed' | 'timeout' | 'handoff' | 'crashed';

export interface ExecutionCleanupOwnership {
  readonly claims: readonly string[];
  assertClosed(): void;
}

export interface RunResourceScopeOptions {
  repoRoot: string;
  baseBranch: string;
  /** Optional for scopes that own only non-git resources, such as a claim lease. */
  branchStrategy?: BranchStrategy;
  branchConfig?: BranchStrategyConfig;
  git?: SimpleGit;
  worktreeBaseDir?: string;
  onCleanup?: () => void | Promise<void>;
  /** When false, terminalizer closes execution sandboxes but leaves primary git ownership to an adapter. */
  managePrimary?: boolean;
  ownership?: {
    workspaceRoot: string;
    repositories?: readonly { platform: string; projectKey: string }[];
    owner: string;
  };
}

interface StepResource {
  handle: BranchHandle;
  strategy?: BranchStrategy;
  config?: BranchStrategyConfig;
  cleanup?: () => Promise<void>;
}

interface HeartbeatResource {
  timer: ReturnType<typeof setInterval>;
  stopped: boolean;
  inFlight: boolean;
  heartbeat: () => Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

interface ExternalResource {
  finish(outcome: { status: RunOutcomeStatus }): Promise<void>;
}

/** Owns every resource created by one workflow and has one terminalizer. */
export class RunResourceScope {
  private readonly git?: SimpleGit;
  private readonly options: RunResourceScopeOptions;
  private primary: BranchHandle | undefined;
  private readonly steps: StepResource[] = [];
  private readonly sandboxes = new Set<Pick<Sandbox, 'close'>>();
  private readonly executions = new Set<Pick<AgentExecution, 'kill'> & { pending?(): boolean }>();
  private readonly heartbeats = new Set<HeartbeatResource>();
  private readonly externalResources: ExternalResource[] = [];
  private finishPromise: Promise<void> | undefined;
  private finalized = false;
  private primaryCleanupPending = false;
  private claimReleased = false;
  private readonly ownershipLeases: ClaimLease[] = [];

  constructor(options: RunResourceScopeOptions) {
    this.options = options;
    // Lease-only scopes should not require repoRoot to exist. Instantiate git
    // lazily only when branch resources are actually managed.
    this.git = options.git;

  }

  private gitForOperations(): SimpleGit {
    return this.git ?? simpleGit(this.options.repoRoot);
  }

  get ownershipClaims(): readonly string[] { return this.ownershipLeases.map(lease => lease.claimId); }
  get hasUnclosedExecutions(): boolean { return this.executions.size > 0; }
  get cleanupOwnership(): ExecutionCleanupOwnership {
    return { claims: this.ownershipClaims, assertClosed: () => {
      if (this.hasUnclosedExecutions) throw new Error('workspace cleanup is blocked by an unclosed owned execution');
    } };
  }

  async acquireOwnership(): Promise<void> {
    const ownership = this.options.ownership;
    if (!ownership || this.ownershipLeases.length) return;
    const lock = new FilesystemClaimLock();
    try {
      for (const key of await executionOwnershipKeys(ownership.workspaceRoot, ownership.repositories)) {
        const lease = await lock.acquire({ key, owner: JSON.stringify({ owner: ownership.owner, pid: process.pid,
          workspaceRoot: ownership.workspaceRoot, release: 'confirmed-execution-cleanup-only' }), ttlMs: 60_000 });
        if (!lease) throw new Error(`workspace or repository is quarantined by an unclosed owned execution: ${ownership.workspaceRoot}`);
        this.ownershipLeases.push(lease);
      }
    } catch (error) {
      const releaseErrors: unknown[] = [];
      for (const lease of [...this.ownershipLeases].reverse()) {
        try {
          await lease.release();
          this.ownershipLeases.splice(this.ownershipLeases.indexOf(lease), 1);
        } catch (releaseError) { releaseErrors.push(releaseError); }
      }
      if (releaseErrors.length) throw new AggregateError([error, ...releaseErrors], 'ownership acquisition cleanup failed', { cause: error });
      throw error;
    }
  }

  async preparePrimary(): Promise<BranchHandle> {
    if (this.primary) return this.primary;
    if (!this.options.branchStrategy || !this.options.branchConfig) {
      throw new Error('a branch strategy and configuration are required to prepare a primary worktree');
    }
    this.primary = await this.options.branchStrategy.prepareWorktree(this.gitForOperations(), this.options.branchConfig, {
      repoPath: this.options.repoRoot,
      baseBranch: this.options.baseBranch,
      worktreeBaseDir: this.options.worktreeBaseDir,
    });
    return this.primary;
  }

  get primaryHandle(): BranchHandle | undefined { return this.primary; }
  adoptPrimary(handle: BranchHandle): void { this.primary = handle; }
  registerStepHandle(handle: BranchHandle, strategy: BranchStrategy, config: BranchStrategyConfig): void;
  registerStepHandle(handle: BranchHandle, cleanup: () => Promise<void>): void;
  registerStepHandle(handle: BranchHandle, strategyOrCleanup: BranchStrategy | (() => Promise<void>), config?: BranchStrategyConfig): void {
    if (typeof strategyOrCleanup === 'function') this.steps.push({ handle, cleanup: strategyOrCleanup });
    else this.steps.push({ handle, strategy: strategyOrCleanup, config: config! });
  }
  registerSandbox(sandbox: Pick<Sandbox, 'close'>): void { this.sandboxes.add(sandbox); }
  registerExecution(execution: Pick<AgentExecution, 'kill'> & { pending?(): boolean }): void { this.executions.add(execution); }
  registerExternalResource(resource: ExternalResource): void { this.externalResources.push(resource); }

  async stopExecutions(): Promise<void> {
    const results = await Promise.allSettled([...this.executions].map(async execution => {
      await execution.kill();
      if (!execution.pending?.()) this.executions.delete(execution);
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  registerHeartbeat(heartbeat: () => Promise<void>, intervalMs: number, onError?: (error: unknown) => void | Promise<void>): () => void {
    if (this.finishPromise) return () => {};
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('heartbeat interval must be positive');
    const resource: HeartbeatResource = {
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      stopped: false,
      inFlight: false,
      heartbeat,
      onError,
    };
    const tick = async () => {
      if (resource.stopped || resource.inFlight) return;
      resource.inFlight = true;
      try {
        await resource.heartbeat();
      } catch (error) {
        if (resource.stopped) return;
        resource.stopped = true;
        clearInterval(resource.timer);
        try { await resource.onError?.(error); } catch { /* best effort */ }
      } finally {
        resource.inFlight = false;
      }
    };
    resource.timer = setInterval(() => { void tick(); }, intervalMs);
    (resource.timer as unknown as { unref?: () => void }).unref?.();
    this.heartbeats.add(resource);
    return () => { resource.stopped = true; clearInterval(resource.timer); };
  }

  /** Idempotent terminal transition. Concurrent callers share the same promise. */
  finish(outcome: { status: RunOutcomeStatus }): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = this.finishOnce(outcome).then(() => {
      if (this.hasUnclosedExecutions) this.finishPromise = undefined;
    }, error => { this.finishPromise = undefined; throw error; });
    return this.finishPromise;
  }

  private async finishOnce(outcome: { status: RunOutcomeStatus }): Promise<void> {
    let firstError: unknown;
    const attempt = async (operation: () => Promise<void>) => {
      try { await operation(); } catch (error) { if (firstError === undefined) firstError = error; }
    };
    await attempt(() => this.stopExecutions());
    for (const sandbox of [...this.sandboxes].reverse()) await attempt(async () => { await sandbox.close(); this.sandboxes.delete(sandbox); });
    if (this.hasUnclosedExecutions) {
      if (firstError !== undefined) throw firstError;
      return;
    }
    if (this.options.managePrimary !== false && outcome.status === 'success' && this.primary && !this.finalized && this.options.branchStrategy && this.options.branchConfig) {
      await attempt(async () => {
        await this.options.branchStrategy!.finalize(this.gitForOperations(), this.options.branchConfig!, this.primary!, { push: true });
        this.finalized = true;
      });
    }

    for (const step of [...this.steps].reverse()) await attempt(async () => {
      await this.cleanupOwned(step);
      this.steps.splice(this.steps.indexOf(step), 1);
    });
    if (firstError !== undefined) throw firstError;
    if ((outcome.status === 'success' || this.primaryCleanupPending) && this.options.managePrimary !== false && this.primary && this.options.branchStrategy && this.options.branchConfig) {
      this.primaryCleanupPending = true;
      await this.options.branchStrategy.cleanup(this.gitForOperations(), this.options.branchConfig, this.primary, { force: true });
      this.primaryCleanupPending = false;
      this.primary = undefined;
    }
    for (const resource of [...this.externalResources].reverse()) await attempt(async () => {
      await resource.finish(outcome);
      this.externalResources.splice(this.externalResources.indexOf(resource), 1);
    });
    if (firstError !== undefined) throw firstError;
    if (!this.claimReleased) {
      await this.options.onCleanup?.();
      this.claimReleased = true;
    }
    for (const lease of [...this.ownershipLeases].reverse()) {
      await lease.release();
      this.ownershipLeases.splice(this.ownershipLeases.indexOf(lease), 1);
    }
    this.stopHeartbeats();
  }

  private stopHeartbeats(): void {
    for (const heartbeat of this.heartbeats) {
      if (heartbeat.stopped) continue;
      heartbeat.stopped = true;
      clearInterval(heartbeat.timer);
    }
    this.heartbeats.clear();
  }

  private async cleanupOwned(step: StepResource): Promise<void> {
    if (step.cleanup) return step.cleanup();
    if (!step.strategy || !step.config || !step.handle.isNewBranch || step.config.type === 'existing') return;
    await step.strategy.cleanup(this.gitForOperations(), step.config, step.handle, { force: true });
  }
}

async function executionOwnershipKeys(workspaceRoot: string, repositories: readonly { platform: string; projectKey: string }[] = []): Promise<string[]> {
  const canonicalRoot = await realpath(workspaceRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(workspaceRoot);
  });
  const identities = [`workspaces/${canonicalRoot}`, ...repositories.filter(repository => repository.platform && repository.projectKey)
    .map(repository => `repositories/${repository.platform === 'github' ? `${repository.platform}:${repository.projectKey}`.toLowerCase() : `${repository.platform}:${repository.projectKey}`}`)];
  return [...new Set(identities)].map(identity => `owned-executions/retained/${createHash('sha256').update(identity).digest('hex')}`).sort();
}

export async function assertWorkspaceOwnershipAvailable(workspaceRoot: string, repositories: readonly { platform: string; projectKey: string }[], ownershipClaims: readonly string[] = []): Promise<void> {
  const lock = new FilesystemClaimLock();
  for (const key of await executionOwnershipKeys(workspaceRoot, repositories)) {
    const held = await lock.inspect(key);
    if (held && !ownershipClaims.includes(held.claimId)) throw new Error(`workspace or repository is quarantined by an unclosed owned execution: ${workspaceRoot}`);
  }
}
