import type { BacklogItem } from './index';

export interface BacklogClaim {
  item: BacklogItem;
  claimId: string;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface ClaimLease {
  claimId: string;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface FilesystemClaimRequest {
  /** A provider-qualified key, for example `github/org-repo/42`. */
  key: string;
  owner: string;
  ttlMs: number;
}

export interface FilesystemClaimLockOptions {
  /** Maximum time to wait for the short-lived filesystem operation gate. */
  gateTimeoutMs?: number;
  /** Delay between operation gate acquisition attempts. */
  gateRetryMs?: number;
  /** Duration after which a dead local operation gate may be recovered. */
  gateStaleMs?: number;
  /** Grace period for recovering a legacy/incomplete lease directory. */
  incompleteClaimGraceMs?: number;
  /** Must mark the provider backlog blocked + hitl before expired lease cleanup. */
  onExpiredClaim?: (key: string, claim: ExpiredClaim) => Promise<boolean>;
}

export interface ExpiredClaim {
  claimId: string;
  owner: string;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
  ttlMs: number;
}

export interface StoredClaim {
  claimId: string;
  owner: string;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
  ttlMs: number;
}

export interface StoredOperationGate {
  gateId: string;
  owner: string;
  pid: number;
  hostname: string;
  createdAt: string;
  expiresAt: string;
}

export interface GateSnapshot {
  identity: string;
  gate: StoredOperationGate | null;
  ageMs: number;
}

export interface ClaimLockSnapshot {
  identity: string;
  claim: StoredClaim | null;
  ageMs: number;
}
