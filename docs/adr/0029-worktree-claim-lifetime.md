# ADR-0029: A worktree claim belongs to the attempt that took it

- Status: accepted
- Date: 2026-11-05

## Context

PRD #27 had a slice, `gitlab:w.src.corp.qihoo.net/fang/web/atlas#7`, whose QA failed for a real reason: the wiki migration left seven governance PNG assets behind. The operator added them, re-ran the item, and the next attempt died in one second:

```
19:10:16 QA processing started
19:10:35 QA workspace prepared
19:10:36 QA execution failed
```

The reason was in the log, not in the item:

```
BranchStrategyError: [named] worktree path '.../atlas/7/repositories/atlas/.worktrees/afk-backlog-7-qa'
is already prepared for branch 'afk/backlog-7-qa'; refusing double-prepare
    at checkNotShared (base.js:85)
    at NamedBranchStrategy.prepareWorktree (named.js:42)
    at GitBranchProvider.createVerificationWorktree (git-provider.js:40)
    at QARunner.processObserved (qa-runner.js:114)
```

The worktree was not prepared at all. `git worktree list` did not know it, and its
directory was empty. Yet AFK refused to prepare it, because AFK keeps its own
registry of prepared worktrees in `packages/runtime/src/domain/branches/base.ts`:

```ts
const preparedWorktrees = new Map<string, string>(); // path -> branch
```

That registry is a claim that two concurrent attempts do not share a writable
branch. It is released in exactly one place — `BranchStrategy.cleanup()` — and
`cleanup()` is also the operation that deletes the worktree files. The QA runner
deliberately does the opposite: a failed verification keeps its worktree, because
the files in it are the evidence of the failure.

```ts
// qa-runner.ts
await this.providers.branches.cleanup(worktreePath, { preserve: !!runtimeErrorSummary });
```

```ts
// git-provider.ts
if (!handle || options.preserve) return;   // ← the claim is never released
```

So a failed verification kept the files and, with them, the claim. The next
verification of the same item prepared the same path for the same branch, found
its own earlier claim, and refused. Every later attempt of that item failed the
same way, in the same process, for the rest of its life — the item could not be
verified again until the process was restarted.

The refusal also made the takeover path unreachable. ADR-0025 and the rework-safe
verification branch it introduced reuse the branch an earlier attempt published
its change request from, so that a re-verification refreshes the existing change
request instead of failing to create a second branch with the same name. That
path sits *after* the claim check, so the one case it was written for — a
verification that failed and left a branch behind — could never reach it.

Two further facts made the failure harder to read than it was:

- Whether a path is a worktree was decided by reading Git's error message. The
  message says "not a working tree" in English, and "不是一个工作区" in Chinese.
  On a machine with a localized Git, removing a path that is not a worktree
  threw instead of being swallowed.
- Git prints the *resolved* path of a worktree, which is not always the path
  AFK asked for: a link anywhere in the path is resolved before Git records it.

## Decision

**A claim belongs to the attempt that took it, and ends with that attempt.**
Keeping the worktree for evidence is a decision about the files; it is not a
decision about the claim.

Three changes follow from that one rule.

1. **The claim is released when the attempt ends, whatever happens to the
   files.** `GitBranchProvider.cleanup()` releases the claim before it decides
   whether to delete the worktree. The claim is what keeps two concurrent
   attempts off one branch; it says nothing about the files on disk.

2. **The takeover of a leftover worktree is deterministic.** The reuse path
   releases whatever stands at the path — the registration for this branch, the
   registration for another branch, and a directory that still holds the files
   of the earlier attempt — before it checks the branch out again. The evidence
   the earlier attempt gathered was already reported by that attempt; the
   leftovers are AFK's own scratch space for that branch.

3. **The facts about worktrees come from the repository, not from Git's
   sentences.** Whether a path is a worktree is answered by
   `git worktree list --porcelain`, and paths are compared with their links
   resolved, because that is the form Git records them in.

The guard itself is unchanged. Two concurrent attempts still cannot share a
writable branch, and a preparation that fails still gives the claim back
(`releasingPathOnFailure`). What changed is that the claim no longer outlives
the attempt that took it.

## Consequences

- A verification that failed can be re-run in the same process. This is the
  common case: every QA verdict failure keeps the worktree for evidence, so
  before this decision every re-verification of every item that failed QA was
  a one-second refusal.
- The rework-safe verification branch from ADR-0025 is reachable. A re-run
  refreshes the change request the earlier attempt published instead of
  failing to create a second branch with the same name.
- A failed attempt's worktree is replaced by the next attempt's checkout. The
  files in it are scratch space; the findings were already reported.
- The registry stays in the process. A process that dies loses its claims with
  it, which is the right lifetime: a claim is about a running attempt, and
  there is no running attempt in a dead process.
