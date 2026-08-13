import { simpleGit, type SimpleGit } from 'simple-git';
import type { BranchHandle, BranchStrategy, BranchStrategyConfig } from '../branches/types';
import type { Sandbox, AgentExecution } from '../sandbox/types';

export type RunOutcomeStatus = 'success' | 'failed' | 'timeout' | 'handoff' | 'crashed';

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

/** Owns every resource created by one workflow and has one terminalizer. */
export class RunResourceScope {
  private readonly git?: SimpleGit;
  private readonly options: RunResourceScopeOptions;
  private primary: BranchHandle | undefined;
  private readonly steps: StepResource[] = [];
  private readonly sandboxes = new Set<Sandbox>();
  private readonly executions = new Set<AgentExecution>();
  private readonly heartbeats = new Set<HeartbeatResource>();
  private finishPromise: Promise<void> | undefined;
  private finalized = false;

  constructor(options: RunResourceScopeOptions) {
    this.options = options;
    // Lease-only scopes should not require repoRoot to exist. Instantiate git
    // lazily only when branch resources are actually managed.
    this.git = options.git;

  }

  private gitForOperations(): SimpleGit {
    return this.git ?? simpleGit(this.options.repoRoot);
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
  registerSandbox(sandbox: Sandbox): void { this.sandboxes.add(sandbox); }
  registerExecution(execution: AgentExecution): void { this.executions.add(execution); }

  registerHeartbeat(heartbeat: () => Promise<void>, intervalMs: number, onError?: (error: unknown) => void | Promise<void>): void {
    if (this.finishPromise) return;
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
  }

  /** Idempotent terminal transition. Concurrent callers share the same promise. */
  finish(outcome: { status: RunOutcomeStatus }): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = this.finishOnce(outcome);
    return this.finishPromise;
  }

  private async finishOnce(outcome: { status: RunOutcomeStatus }): Promise<void> {
    this.stopHeartbeats();
    let firstError: unknown;
    const attempt = async (operation: () => Promise<void>) => {
      try { await operation(); } catch (error) { if (firstError === undefined) firstError = error; }
    };
    for (const execution of [...this.executions].reverse()) {
      try { await execution.kill(); } catch { /* best effort */ }
    }
    for (const sandbox of [...this.sandboxes].reverse()) {
      try { await sandbox.close(); } catch { /* best effort */ }
    }

    if (this.options.managePrimary !== false && outcome.status === 'success' && this.primary && !this.finalized && this.options.branchStrategy && this.options.branchConfig) {
      this.finalized = true;
      await attempt(() => this.options.branchStrategy!.finalize(this.gitForOperations(), this.options.branchConfig!, this.primary!, { push: true }));
    }

    for (const step of [...this.steps].reverse()) await attempt(() => this.cleanupOwned(step));
    if (outcome.status === 'success' && this.options.managePrimary !== false && this.primary && this.options.branchStrategy && this.options.branchConfig) {
      await attempt(() => this.options.branchStrategy!.cleanup(this.gitForOperations(), this.options.branchConfig!, this.primary!, { force: true }));
    }

    // Claim release is best-effort cleanup. It must never replace the run's
    // original terminal error (for example a branch finalization failure).
    try { await this.options.onCleanup?.(); } catch { /* provider recovers stale leases */ }
    if (firstError !== undefined) throw firstError;
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
