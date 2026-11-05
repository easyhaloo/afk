# ADR-0030: AFK's own worktrees are invisible to the user's repository

- Status: accepted
- Date: 2026-11-05

## Context

PRD #27 publishes its slices as merge requests into `prd/27`. Two of the
published requests carried an entry nobody asked for:

```
 .worktrees/afk-backlog-2-qa | 1 +
@@ -0,0 +1 @@
+Subproject commit e59ce4e373e7aa1e98f3357ea37024adaef93d75
```

That is a submodule pointer. AFK keeps its worktrees inside the checkout —
`<checkout>/.worktrees/<branch>` — so Git sees them as content of the user's
repository:

- `git add -A` stages a nested worktree as a **gitlink**, and the change
  request carries a submodule whose commit exists in no remote. Merging it
  puts a broken submodule into the product repository.
- `git status` reports the worktree directory as the user's uncommitted work.
  The preparer refuses a checkout that carries uncommitted changes, so an
  item whose QA worktree was kept for evidence could not be prepared again —
  every later attempt failed with "repository has uncommitted changes".

The repository store already had the answer for AFK's other runtime
artifacts. `.afk/` and `.afk-signal.json` are filtered out of the status the
preparer reads, and `.afk` is excluded from the commit that publishes the
change. The worktree directory was simply missing from that list, even though
it is the same kind of thing: process state that lives inside the user's
checkout.

## Decision

**AFK's own worktrees are invisible to the user's repository.** Three places
learn about them:

1. **The checkout ignores them.** When AFK prepares a worktree, it writes the
   worktree directory into the repository's own ignore file — the local
   `info/exclude`, not the product's `.gitignore`. The directory is AFK's
   scratch space on this machine; the product repository should never learn
   that it exists.

2. **The commit does not carry them.** The commit that publishes the change
   excludes `.worktrees`, and drops it from the index when an earlier attempt
   already tracked it. Tracked means it is part of the change request, so it
   is removed rather than carried.

3. **The preparer does not read them as uncommitted work.** `.worktrees`
   joins `.afk` in the runtime-artifact list the preparer filters out. This is
   the belt to the ignore file's braces: the checkout may be one AFK did not
   prepare, and an item must not be locked out by AFK's own scratch space.

## Consequences

- A change request never carries a submodule pointer. Two published requests
  had to be cleaned up by hand; from now on they do not get created.
- An item whose verification worktree was kept as evidence can be prepared
  again. Before this decision, the leftover directory made every later
  attempt fail with "repository has uncommitted changes".
- The product repository is untouched: the ignore rule lives in the local
  `info/exclude` of the checkout, so it never travels into a commit.
- The worktrees stay where they are. Moving them out of the checkout would
  cost the shared object library the worktrees rely on, and the directory
  would still exist somewhere AFK has to keep out of the repository's view.
