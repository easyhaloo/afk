import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FilesystemClaimLock, type ClaimLease, type ExpiredClaim } from '../../domain/backlog/claim.js';
import { getAfkResourceRegistry, type AfkResourceRegistry } from '../runtime/resource-registry.js';
import { TmuxClient } from '../tmux/tmux.js';

function deadOwner(claim: ExpiredClaim): boolean {
  try {
    const owner = JSON.parse(claim.owner);
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch { return false; }
}

type LeaseSet = { heartbeat(): Promise<void>; release(): Promise<void>; claimIds?: string[] };
const scope = new AsyncLocalStorage<{ keys: readonly string[]; leases: LeaseSet }>();

export function repositoryClaimIds(): string[] {
  return scope.getStore()?.leases.claimIds ?? [];
}

export async function recoverRepositoryLease(claim: ExpiredClaim, dependencies: {
  registry?: Pick<AfkResourceRegistry, 'listAllActive' | 'markClosed'>;
  tmux?: Pick<TmuxClient, 'sessionStatus' | 'firstPaneId' | 'killSession' | 'sessionOwnership'>;
  dead?: (claim: ExpiredClaim) => boolean;
} = {}): Promise<boolean> {
  if (!(dependencies.dead ?? deadOwner)(claim) || JSON.parse(claim.owner).recovery !== 'registered-tmux') return false;
  const registry = dependencies.registry ?? getAfkResourceRegistry();
  const tmux = dependencies.tmux ?? new TmuxClient();
  for (const resource of registry.listAllActive()) {
    const ids = resource.metadata.repositoryClaims;
    if (!Array.isArray(ids) || !ids.includes(claim.claimId)) continue;
    if (resource.kind !== 'tmux') return false;
    const status = await tmux.sessionStatus(resource.name);
    if (status === 'unknown') return false;
    if (status === 'present') {
      if (await tmux.sessionOwnership(resource.name) !== ids.join(',')) return false;
      const pane = resource.metadata.tmuxPaneId;
      const window = resource.metadata.tmuxWindowName;
      if (typeof pane === 'string' && (typeof window !== 'string'
        || await tmux.firstPaneId(resource.name, window) !== pane)) return false;
      await tmux.killSession(resource.name);
      if (await tmux.sessionStatus(resource.name) !== 'missing') return false;
    }
    registry.markClosed({ ...resource, status: status === 'missing' ? 'missing' : 'closed', detail: 'expired repository lease owner recovered' });
  }
  return true;
}

export function repositoryLeaseKey(key: string): string {
  const normalized = key.startsWith('github:') ? key.toLowerCase() : key;
  return `repositories/${createHash('sha256').update(normalized).digest('hex')}/execution`;
}

export class RepositoryLeases {
  private readonly lock: FilesystemClaimLock;
  constructor(stateRoot?: string) {
    this.lock = new FilesystemClaimLock(stateRoot, { onExpiredClaim: async (_key, claim) => recoverRepositoryLease(claim) });
  }

  async run<Result>(keys: readonly string[], operation: () => Promise<Result>, registeredTmux = false): Promise<Result> {
    const leases = await this.acquire(keys, registeredTmux);
    let lost: unknown;
    let pending: Promise<void> | undefined;
    const heartbeat = async () => {
      if (lost) throw lost;
      await leases.heartbeat();
    };
    const timer = setInterval(() => {
      if (!pending) pending = heartbeat().catch(error => { lost = error; }).finally(() => { pending = undefined; });
    }, 10_000);
    timer.unref();
    try {
      const result = await scope.run({ keys, leases: { ...leases, heartbeat } }, operation);
      await heartbeat();
      return result;
    }
    finally { clearInterval(timer); await pending; await leases.release(); }
  }

  async active(keys: readonly string[]): Promise<boolean> {
    for (const key of keys) {
      const claim = await this.lock.inspect(repositoryLeaseKey(key));
      if (claim) return true;
    }
    return false;
  }

  async acquire(keys: readonly string[], registeredTmux = false): Promise<LeaseSet> {
    const inherited = scope.getStore();
    if (inherited && keys.every(key => inherited.keys.includes(key))) {
      await inherited.leases.heartbeat();
      return { heartbeat: inherited.leases.heartbeat, claimIds: inherited.leases.claimIds, release: async () => {} };
    }
    const leases: ClaimLease[] = [];
    try {
      for (const key of [...new Set(keys)].sort()) {
        const lease = await this.lock.acquire({ key: repositoryLeaseKey(key), owner: JSON.stringify({ pid: process.pid, host: hostname(),
          recovery: registeredTmux ? 'registered-tmux' : 'manual' }), ttlMs: 60_000 });
        if (!lease) throw new Error(`repository is leased by another execution: ${key}`);
        leases.push(lease);
      }
    } catch (error) {
      await Promise.all(leases.map(lease => lease.release()));
      throw error;
    }
    return {
      claimIds: leases.map(lease => lease.claimId),
      heartbeat: async () => { for (const lease of leases) await lease.heartbeat(); },
      release: async () => { for (const lease of [...leases].reverse()) await lease.release(); },
    };
  }
}
