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

   The exclusion is done by unstaging the path after the add, not by naming
   it in the add's pathspec. Git refuses to add a path that is ignored, and
   this decision makes the checkout ignore exactly that path — so a
   pathspec that names it fails the whole commit with "the following paths
   are ignored by one of your .gitignore files", and the item publishes
   nothing at all. Unstaging after the add has the same outcome and does not
   depend on the path being addable in the first place.

3. **The preparer does not read them as uncommitted work.** `.worktrees`
   joins `.afk` in the runtime-artifact list the preparer filters out. This is
   the belt to the ignore file's braces: the checkout may be one AFK did not
   prepare, and an item must not be locked out by AFK's own scratch space.

   The ignore file is written where Git says the repository's own ignore
   file is. Git answers `--git-path info/exclude` with a path relative to
   the repository — `.git/info/exclude` — unless the checkout is a linked
   worktree of a bare repository, where it answers with the common
   directory's absolute path. A relative answer is relative to the
   repository, not to the process: resolved against the working directory,
   the rule would be written into whatever directory AFK happened to run in,
   and the worktree directory would stay visible.

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
- The two halves of this decision only work together. The ignore file makes
  the worktree directory invisible to the repository's view, and the commit
  path has to cope with a path it cannot add. The two were written apart
  and met in production: the first item that published a change afterwards
  failed with the commit error above, and nothing was published at all.
