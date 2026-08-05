import { randomUUID } from 'node:crypto';
import type { BacklogClaim, BacklogItem } from './index';
import type { ClaimLease, ExpiredClaim, FilesystemClaimRequest } from './claim';

export interface AtomicClaimPredicate {
  state: 'ready';
  executionMode: 'afk';
  parentId?: string;
  dependencies: readonly string[];
}

export type AtomicClaim = (
  backlogId: string,
  owner: string,
  expected: 'ready',
  predicate: AtomicClaimPredicate,
) => Promise<boolean>;

/** The minimal filesystem lease capability required by the locked strategy. */
export interface ClaimLock {
  acquire(request: FilesystemClaimRequest): Promise<ClaimLease | null>;
}

export type ClaimLockFactory = (
  onExpiredClaim: (key: string, claim: ExpiredClaim) => Promise<boolean>,
) => ClaimLock;

export interface ClaimStrategyDependencies {
  atomicClaim?: AtomicClaim;
  claimLock: ClaimLock;
  claimKey(backlogId: string): string;
  claimTtlMs: number;
  read(backlogId: string): Promise<BacklogItem>;
  isRunnable(item: BacklogItem): Promise<boolean>;
  transitionToInProgress(backlogId: string): Promise<void>;
  isConfirmedClaim(item: BacklogItem): Promise<boolean>;
  blockAndRouteToHitl(backlogId: string, reason?: string): Promise<boolean>;
}

/**
 * Chooses the provider-native conditional mutation when it is available.
 * Otherwise, a filesystem lease serializes the complete read/check/mutate/
 * verify critical section for workers sharing the same reliable filesystem.
 */
export class NativeOrLockedClaimStrategy {
  constructor(private readonly dependencies: ClaimStrategyDependencies) {}

  async claim(backlogId: string, owner: string): Promise<BacklogClaim | null> {
    if (this.dependencies.atomicClaim) return this.claimNatively(backlogId, owner);
    return this.claimWithLease(backlogId, owner);
  }

  private async claimNatively(backlogId: string, owner: string): Promise<BacklogClaim | null> {
    const item = await this.dependencies.read(backlogId);
    if (!(await this.dependencies.isRunnable(item))) return null;
    const predicate: AtomicClaimPredicate = {
      state: 'ready',
      executionMode: 'afk',
      parentId: item.parentId,
      dependencies: item.dependsOn,
    };
    let committed = false;
    try {
      committed = await this.dependencies.atomicClaim!(backlogId, owner, 'ready', predicate);
      if (!committed) return null;
      const claimed = await this.dependencies.read(backlogId);
      if (!(await this.dependencies.isConfirmedClaim(claimed))) {
        await this.blockAfterFailedMutation(backlogId, 'native claim confirmation failed');
        return null;
      }
      return { item: claimed, ...noOpLease(`native:${backlogId}:${owner}:${randomUUID()}`) };
    } catch (error) {
      await this.blockAfterFailedMutation(
        backlogId,
        committed ? 'native claim confirmation read failed' : 'native claim operation failed',
      );
      throw error;
    }
  }

  private async claimWithLease(backlogId: string, owner: string): Promise<BacklogClaim | null> {
    const lease = await this.dependencies.claimLock.acquire({
      key: this.dependencies.claimKey(backlogId),
      owner,
      ttlMs: this.dependencies.claimTtlMs,
    });
    if (!lease) return null;

    let mutationAttempted = false;
    let operationError: unknown;
    let claimed = false;
    try {
      const item = await this.dependencies.read(backlogId);
      if (!(await this.dependencies.isRunnable(item))) return null;
      mutationAttempted = true;
      await this.dependencies.transitionToInProgress(backlogId);
      const confirmed = await this.dependencies.read(backlogId);
      if (!(await this.dependencies.isConfirmedClaim(confirmed))) {
        await this.blockAfterFailedMutation(backlogId, 'filesystem claim confirmation failed');
        return null;
      }
      claimed = true;
      return { item: confirmed, ...lease };
    } catch (error) {
      operationError = error;
      if (mutationAttempted) await this.blockAfterFailedMutation(backlogId, 'filesystem claim confirmation read failed');
      throw error;
    } finally {
      if (!claimed) {
        try {
          await lease.release();
        } catch (releaseError) {
          if (operationError === undefined) throw releaseError;
        }
      }
    }
  }

  private async blockAfterFailedMutation(backlogId: string, reason: string): Promise<void> {
    try {
      await this.dependencies.blockAndRouteToHitl(backlogId, reason);
    } catch {
      // Blocking is best-effort here: preserve the original confirmation
      // error, and let the provider's durable state remain the authority.
    }
  }
}

function noOpLease(claimId: string): ClaimLease {
  return { claimId, heartbeat: async () => {}, release: async () => {} };
}
