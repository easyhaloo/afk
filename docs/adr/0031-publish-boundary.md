# ADR-0031: The target branch belongs to AFK's change request

- Status: accepted
- Date: 2026-11-05

## Context

PRD #27 publishes its slices as merge requests into `prd/27`. One slice
never reached a person, because the branch it was meant to merge into was
moved forward by the agent that wrote it.

The evidence is in the reflog of the bare clone and in the implement
agent's own session log:

```
21:12:20  origin/afk/backlog-9: 40fe9326 → 1ebf8851
21:20:05  origin/prd/27:       0c6eebe0 → 1ebf8851   "update by push"
```

At 21:20:02 the agent ran `git push origin HEAD:prd/27` and reported it as
"Executing authorized git push to prd/27".

Two things had to be true for that push to look authorized:

1. **The prompt named the target branch next to the working branch.**
   AFK's `Execution repositories:` segment lists
   `baseBranch=prd/27 targetBranch=prd/27 sourceBranch=… workingBranch=afk/backlog-9`
   — four branch names in one line, with no statement of which of them the
   agent may move. The completion protocol said "work only on the current
   checked-out branch", which forbids *switching* branches and says nothing
   about where commits may be *pushed*.

2. **The rework summary said "publish to `prd/27`".** The operator-facing
   text and the branch the change request merges into shared a name, and
   the agent read the name as a push destination.

AFK has no vocabulary for the difference. All four of its own pushes are
same-name pushes (`repository-store.ts`, `merge-to-head.ts`, `git-provider.ts`,
`multi-repository-preparer.ts`), so there is no "push this branch somewhere
else" in AFK at all — and no place where the difference between "the branch
the change request merges into" and "the branch the agent pushes" is written
down.

### What the push caused

The change request had nothing left to merge: the target branch already
carried its commits. GitLab reported the merge request as
`cannot_be_merged` with `has_conflicts: true`, and `diff_refs.base_sha`,
`diff_refs.head_sha` and `diff_refs.start_sha` all pointed at the same
commit — an empty diff.

AFK read that as a conflict. `mergeStateOf()` mapped
`cannot_be_merged` to `'conflict'`, `detectPublishedConflict()` turned that
into "the target branch changed the same lines", and `openConflictRework()`
sent the item back for another round with `executionMode=afk`.

The scheduler dispatches `rework` items. So the next round ran the same
agent on the same item, which pushed the same baseline again, and the
change request was still unmergeable, and the item was sent back again.

**The loop had no end**, because the thing AFK called a conflict was not a
conflict at all. It was AFK's own agent moving AFK's own baseline, and the
only way out of it was for a person to notice and roll the branch back.

## Decision

**The target branch belongs to AFK's change request, and AFK is the only
thing that moves it.** Three rules make that hold.

### 1. The prompt states the boundary

Every agent reads the completion protocol, in both transports and for every
phase. It now carries the rule:

> Push your commits only to the branch you are working on. The base branch
> and the target branch of the change request belong to AFK: read them,
> never push to them. Publishing the change request is AFK's job, and AFK
> stops the run when it finds the target branch moved.

The `Execution repositories:` segment states the same rule with the branch
names, so the agent does not have to infer which of the four names it may
move: the working branch is named as the agent's, and the base, target and
source branches are named as AFK's.

`describePublishBoundary()` in
`packages/runtime/src/domain/branches/publish-boundary.ts` is the single
place that text comes from, so the two cannot drift apart.

### 2. A baseline that advanced is not a conflict

`ChangeMergeState` gains a fourth value, `baseline_advanced`, beside
`mergeable`, `conflict` and `unknown`:

- GitLab: `cannot_be_merged` **with an empty diff** — the merge base of the
  target and source branches is the source head itself — is a baseline that
  advanced. `cannot_be_merged` with a real diff stays a conflict.
- GitHub: `mergeable_state: behind` is the same situation.

The diff is what separates them, and the diff is what distinguishes the
failure from the conflict it was mistaken for. Before this decision the
two were one value, and one value cannot answer two questions.

### 3. A baseline that advanced goes to a person

`decideMergeVerdict()` maps a merge verdict to an action, and the three
answers are deliberately different:

| verdict | action | why |
|---|---|---|
| `mergeable` | accept | hand it to a person to merge |
| `conflict` | rework | the content disagrees; another round can fix it |
| `baseline_advanced` | **escalate** | the work is already in the baseline; another round would move the baseline again |

The escalated item is blocked with `executionMode=hitl`. It is not sent
back for rework, because the rework would be answered by the same push
that caused it. The failure carries its own code, `baseline_advanced`,
next to `merge_conflict`, so a reader can tell the two apart.

## Consequences

- An agent that pushes to the target branch no longer starts a loop. The
  change request is published, the empty diff is recognised, and the item
  stops in a state a person can act on.
- A change request whose target branch moved for an ordinary reason — a
  human merged another slice into the PRD baseline — is unaffected: the
  diff is non-empty, the content does not conflict, and the change request
  is mergeable as before.
- The `mergeable` flag on a change request and the `mergeState` verdict
  now answer different questions. `mergeable` is the platform's own
  "can this be merged right now"; `mergeState` is AFK's reading of what
  the reason is. They disagree on purpose.
- The boundary is stated in words, not enforced by the sandbox. An agent
  that ignores the instruction still moves the baseline — AFK's answer is
  then the detection and the escalation, not the prevention.
- AFK still has no way to push a branch to a *different* name. The
  boundary does not need one: the agent's push target and the change
  request's target branch are different branches, and AFK publishes the
  change request from the verification branch it owns.
