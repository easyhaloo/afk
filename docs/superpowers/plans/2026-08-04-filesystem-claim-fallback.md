# Filesystem Claim Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each platform-specific backlog provider safely claim work on one host by using a filesystem lease only when the provider lacks native CAS.

**Architecture:** GitHub, GitLab, and future Linear adapters remain direct `BacklogProvider` implementations. Their `claim()` delegates to a `ClaimStrategy`: native CAS when available, otherwise a durable filesystem lease that guards re-read, runnable validation, and `ready -> in_progress`. The runner owns the returned lease and releases it exactly once through `RunResourceScope.finish()`.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest, existing `BacklogProvider` and `RunResourceScope` contracts.

---

### Task 1: Define Claim and Lock Contracts

**Files:**
- Modify: `src/lib/core/backlog/index.ts`
- Create: `src/lib/core/backlog/claim.ts`
- Test: `src/lib/core/backlog/claim.test.ts`

- [ ] **Step 1: Write failing claim-contract tests**

```ts
it('creates one filesystem lease for competing claimers', async () => {
  const store = new FilesystemClaimLock(tempDir);
  const [first, second] = await Promise.all([
    store.acquire({ key: 'github/org-repo/42', owner: 'worker-a', ttlMs: 60_000 }),
    store.acquire({ key: 'github/org-repo/42', owner: 'worker-b', ttlMs: 60_000 }),
  ]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run src/lib/core/backlog/claim.test.ts`

Expected: failure because `FilesystemClaimLock` does not exist.

- [ ] **Step 3: Add the provider-neutral claim types**

```ts
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
```

Change `BacklogProvider.claim()` to return `Promise<BacklogClaim | null>`.

- [ ] **Step 4: Implement `FilesystemClaimLock`**

Use a project-qualified key under `${AFK_STATE_DIR ?? ~/.afk/state}/claims/`. Acquire a lock using `mkdir(lockPath)`; write `claim.json` through temporary file, `fsync`, and `rename`; delete the lock directory only when its stored `claimId` matches the lease.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm exec vitest run src/lib/core/backlog/claim.test.ts && pnpm typecheck`

Expected: pass.

### Task 2: Implement Native-or-Locked Claim Strategy

**Files:**
- Create: `src/lib/core/backlog/claim-strategy.ts`
- Modify: `src/lib/core/backlog/tracker-adapter.ts`
- Modify: `src/lib/core/backlog/tracker-adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests**

```ts
it('uses the filesystem lease to serialize a tracker claim without native CAS', async () => {
  const provider = new TrackerBacklogProvider(tracker, { claimLock });
  const [first, second] = await Promise.all([provider.claim('42', 'a'), provider.claim('42', 'b')]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
});

it('uses native CAS without acquiring a fallback lease', async () => {
  const provider = new TrackerBacklogProvider(tracker, { atomicClaim, claimLock });
  await provider.claim('42', 'a');
  expect(claimLock.acquire).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm exec vitest run src/lib/core/backlog/tracker-adapter.test.ts`

Expected: failure because the adapter still requires injected `atomicClaim`.

- [ ] **Step 3: Implement strategy selection**

Native strategy invokes existing conditional callback and returns a no-op lease. Locked strategy retains the filesystem lease while it re-reads the item, verifies `isRunnable()`, transitions it to `in_progress`, re-reads confirmation, and returns `null` plus releases the lease on every failed precondition.

- [ ] **Step 4: Include provider namespace in lock keys**

Build the lock key from `platform`, `projectId`, and backlog ID. Never use only the numeric backlog ID.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm exec vitest run src/lib/core/backlog/tracker-adapter.test.ts && pnpm typecheck`

Expected: pass.

### Task 3: Propagate Leases Through Execution Lifecycle

**Files:**
- Modify: `src/lib/core/backlog/index.ts`
- Modify: `src/lib/workflows.ts`
- Modify: `src/lib/workflows/resource-scope.ts`
- Modify: `src/lib/workflows/backlog-provider.test.ts`
- Test: `src/lib/workflows/resource-scope.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('releases the claim lease exactly once when a run finishes', async () => {
  const release = vi.fn(async () => {});
  const scope = new RunResourceScope({ ...options, onCleanup: release });
  await Promise.all([scope.finish({ status: 'success' }), scope.finish({ status: 'failed' })]);
  expect(release).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm exec vitest run src/lib/workflows/resource-scope.test.ts`

Expected: failure because no claim lease cleanup is registered.

- [ ] **Step 3: Register lease release when the runner claims a backlog**

Store `claim.item` as the active backlog. Attach `claim.release` to the resource scope's cleanup hook before sandbox or branch resources are created, so all success, failure, timeout, crash, and handoff paths release it.

- [ ] **Step 4: Update in-memory provider and runner tests**

`InMemoryBacklogProvider` returns a no-op lease. Tests assert the runner reads `claim.item` and resource scope invokes release exactly once.

- [ ] **Step 5: Run focused lifecycle tests**

Run: `pnpm exec vitest run src/lib/workflows/backlog-provider.test.ts src/lib/workflows/resource-scope.test.ts`

Expected: pass.

### Task 4: Configure Default Local Claim Fallback and Document Scope

**Files:**
- Modify: `src/lib/core/providers.ts`
- Modify: `src/lib/client-factory.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE_zh.md`
- Test: `src/lib/core/providers.test.ts`

- [ ] **Step 1: Write failing bundle tests**

```ts
it('constructs tracker adapters with a project-qualified filesystem claim fallback', () => {
  const bundle = createProviderBundle(tracker, '/repo');
  expect(bundle.backlog.capabilities?.atomicClaim).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm exec vitest run src/lib/core/providers.test.ts`

Expected: failure because execution bundle still rejects a tracker adapter without `atomicClaim`.

- [ ] **Step 3: Wire the fallback at bundle construction**

Default to `FilesystemClaimLock` for tracker adapters without a native claim callback. Preserve injected native `atomicClaim`; it takes precedence and does not create a lock lease.

- [ ] **Step 4: Document the single-host boundary**

Document that filesystem locking coordinates workers on one host only. Multi-host execution requires shared reliable storage or a provider-native CAS strategy. State that GitHub/GitLab/Linear remain direct `BacklogProvider` implementations.

- [ ] **Step 5: Run full verification**

Run:

```bash
pnpm typecheck
pnpm build
pnpm exec vitest run
git diff --check
```

Expected: all commands exit 0.
