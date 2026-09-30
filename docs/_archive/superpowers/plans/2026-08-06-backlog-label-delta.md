# Backlog Label Delta Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make workflow label updates persist only the labels that were added or removed.

**Architecture:** Add a provider-neutral `updateLabels` delta contract to `TrackerProvider`. GitHub and GitLab implement native label add/remove operations, while the backlog adapter computes a single stage/mode delta from a fresh issue read and leaves business labels untouched.

**Tech Stack:** TypeScript, Vitest, Octokit, GitLab API client.

---

### Task 1: Define the label-delta contract

**Files:**
- Modify: `src/lib/core/tracker/types.ts`
- Test: `src/lib/core/tracker` provider tests covering the new method shape

- [x] Add `LabelDelta` with `add` and `remove` string arrays and add `updateLabels(id, delta)` to `TrackerProvider`.
- [x] Run `pnpm exec tsc --noEmit` to identify every provider and test double that must implement the contract.
- [x] Update the in-memory and test provider implementations with a minimal delta mutation.
- [x] Run the tracker and backlog tests and commit the contract changes.

### Task 2: Implement platform-native label mutations

**Files:**
- Modify: `src/lib/core/github/client.ts`
- Modify: `src/lib/core/gitlab/index.ts`
- Test: `src/lib/core/providers.test.ts` and platform-specific provider tests

- [x] Implement GitHub `updateLabels` with `issues.removeLabel` for removals and `issues.addLabels` for additions, skipping empty lists.
- [x] Implement GitLab `updateLabels` with its issue label add/remove endpoints, preserving the same delta semantics.
- [x] Verify that no implementation calls the full-label replacement API for this method.
- [x] Run focused provider tests and commit the platform implementations.

### Task 3: Compute workflow deltas in the backlog adapter

**Files:**
- Modify: `src/lib/core/backlog/tracker-adapter.ts`
- Test: `src/lib/core/backlog/tracker-adapter.test.ts`

- [x] Add a helper that derives exactly one target `stage::*` and one effective `mode::*` label.
- [x] Compare current and desired workflow metadata and call `updateLabels` with only `add` and `remove` differences.
- [x] Keep `setExecutionMode` on the same delta path and preserve the current stage.
- [x] Add tests for non-blocked mode preservation, blocked mode forcing, business-label retention, no-op transitions, and removal of stale duplicate workflow labels.
- [x] Run the focused backlog tests and commit the adapter changes.

### Task 4: Verify and publish

**Files:**
- Modify: none beyond the files above

- [x] Run `pnpm exec vitest run` and record passed/skipped counts.
- [x] Run `pnpm run typecheck`, `pnpm run build`, and `git diff --check`.
- [x] Inspect the final diff and push the branch so MR #93 contains the change.
