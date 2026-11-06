# ADR-0036: A schedule is judged against the range it depends on

- Status: accepted
- Date: 2026-11-06

## Context

The scheduler reads the whole platform. It has to: a PRD's slices live in
the repositories the work touches, and on this machine the credentials reach
**46** GitLab projects while PRD #27 lives in **7** of them.

The read produced two things: the work items, and a verdict. The verdict was
all-or-nothing:

```ts
// packages/runtime/src/infrastructure/provider/inventory.ts
complete: diagnostics.length === 0,
```

and the scheduler obeyed it:

```ts
// packages/runtime/src/application/runners/scheduler.ts
if (!result.complete) throw new Error(`schedule inventory is incomplete: ${…}`);
```

So a diagnostic about *any* project the credentials reach — a repository that
was deleted, a token whose scope changed, one 500 from one project — made the
whole platform "incomplete", and the schedule backed off and dispatched
nothing. The machine's own inventory shows how easily that happens:

```
afk backlog inventory --platform all
→ complete: false
  {platform: github, projectKey: easyhaloo/shadowsocks-heroku,
   code: issue_list_failed, message: "Repository access blocked"}
```

That project has nothing to do with PRD #27. Its failure blinded the whole
PRD anyway: the scheduler stayed alive, the log stayed empty, and no slice
was dispatched. The operator saw one warning line.

This is the same disease as the 402 the provider/runtime mismatch produced
(ADR-0032): **AFK looks like it is running, and it is seeing nothing.** A
failure that is not about the work must not be allowed to look like a
failure of the work.

## The defect is a range defect, not a threshold defect

The completeness check exists for a real reason: *do not schedule on a
broken view*. If AFK cannot see whether a dependency is done, dispatching the
slice that waits for it would run work out of order. That guarantee is
worth keeping, and this ADR does not weaken it.

What was wrong was the **range** the guarantee was measured against. The
scheduler needed "this PRD's subtree and the work it waits for". The check
measured "every project the credentials reach". Two different ranges, treated
as one, and the wider one won every time.

The fix is therefore not to lower the bar but to **narrow the measurement to
the range the decision actually depends on** — and to say, out loud, which
projects are inside that range and which are not.

## Decision

**A schedule is judged against the range it depends on. A failure outside
that range is reported and never fatal; a failure inside it holds back the
work that depends on it, and says which.**

### The scope is the PRD's subtree and its dependency closure

`packages/runtime/src/domain/backlog/schedule-scope.ts` owns the concept:

- the **parent PRD**;
- its **children**, transitively — a slice names its parent;
- everything those **wait for**, transitively — a slice names the work it
  depends on.

The scope is a set of *projects* as well as a set of *items*. It is derived
from the relationships AFK itself writes, and those relationships cross
repositories: PRD #27's slices live in `llm-wiki`, `k-base`, `open-api`,
`console`, `aiapi`, `papilot` and `atlas`, and its dependencies cross those
same repositories.

### An unreadable dependency still names its project

This is the load-bearing rule, and it is the reason the scope is computed
from *identities* rather than from *rows*.

A canonical work item identity carries its project key:
`gitlab:w.src.corp.qihoo.net/fang/services/k-base#3`. So when a slice
depends on a piece of work in a repository whose issue list could not be
read, AFK still knows **which repository matters** — the dependency names it.
The repository therefore belongs to the scope even though not one of its
items was ever read.

Without this rule the scope would have a hole exactly where the danger is:
the unreadable dependency would look like "nothing references it", it would
be classified as outside the scope, and the slice that waits for it would be
dispatched on a view of the world that does not exist. **A gap in the data
must not be mistaken for evidence that there is nothing there.**

### A failure outside the range is reported, not fatal

A diagnostic about a project that is not in the scope is:

- **named** — the project, the code and the message are in the log, in the
  status and in the final report;
- **not fatal** — the schedule keeps dispatching.

The argument is not that out-of-scope failures are unimportant. It is that
**a failure is only a failure of the thing it is about.** The credential
reaches 46 projects; the PRD lives in 7. A repository that the PRD does not
touch cannot change a single decision this schedule makes, so letting it stop
the schedule is not caution — it is the schedule refusing to do its job
because of a stranger's outage. The operator still gets the truth: the
project is named, every time the picture changes, and the report ends with
the list.

### A failure inside the range holds back the work that depends on it

A diagnostic about a project *in* the scope is fatal — for the work that
depends on it, and not for the rest of the tree.

The rule is item-level, because the information is item-level. A slice whose
dependency lives in an unreadable repository cannot be dispatched, because
the state it would be dispatched on is unknown. A slice in another
repository, waiting on nothing unreadable, is dispatched as usual. One
broken repository does not paralyze the PRD; it paralyzes the slices that
need it.

The scheduler says so in three places:

- the **wait reason** — `visibility_unknown`: "the project that holds a
  dependency cannot be read";
- the **scope report** — the unreadable projects, and the items held back;
- the **log** — an error line naming the project, its code and whether the
  failure can be retried.

### A project list failure is always inside the scope

`project_list_failed` means AFK could not enumerate the candidate projects.
It cannot then prove that any project is *outside* the scope: a PRD may
reach a project AFK never saw the name of. A candidate that was never
enumerated cannot be excluded, so the failure is held inside the scope and
the whole scope waits.

### A failure that cannot be retried is escalated, not retried forever

`toDiagnostic` already computed `retryable` for every diagnostic, and the
scheduler ignored it. A repository that was deleted does not come back by
being read again: retrying it a million times is still a million failures.
So an in-scope failure that is **not** retryable is escalated:

- the log says so at **error** level, and says that a person has to act;
- the affected items wait as `awaiting_human` — a person, not a timer;
- the scheduler does **not** go down the backoff path, because the read
  itself succeeded and the failure is not transient.

AFK does not write this state to the provider. The items of an unreadable
project cannot be read, so they cannot be marked; and marking the visible
items `blocked` because a read failed would turn a provider-side fact into
a mutation of AFK's own record of the work. The escalation is a **visible
report**, and the repository's own rule still holds: a provider edit the CLI
does not support is a gap in the CLI, not a licence to write around it.

### The anchor has its own failure mode

The parent PRD is the anchor of the scope: without it AFK knows nothing
about the PRD, so a missing parent is a *failed read for this schedule* —
it backs off and retries like any other temporary failure. The old code
threw `schedule parent is absent from inventory` straight out of the
scheduler and killed it, which turned one unreadable repository into a dead
process. A parent that is missing while **no** project failed is a
different answer: the PRD does not exist, and that is reported as an error
rather than retried forever.

## Consequences

- A failure in a project the PRD does not touch no longer stops the PRD.
  The schedule dispatches what it can see, and names what it could not read.
- A failure in a project the PRD does touch holds back exactly the slices
  that need it, and the operator is told which ones and why.
- The completeness guarantee is kept: AFK does not schedule work whose
  state it cannot see.
- The scope is a first-class concept now, and other surfaces can ask the
  same question: "is this failure about what I am deciding?"

### What this does not fix

The scope is computed from the relationships AFK can see. A slice in a
repository whose issue list could not be read, and which **nothing else
references**, cannot be discovered: the child names its parent, and nothing
points at the child. Such a slice stays invisible, and the PRD waits for it
without saying which slice it waits for.

That is a false negative — AFK under-dispatches rather than dispatching
something wrong — and it is reported: the unreadable repository is named in
the log, in the scope report and on the command line. Closing it properly
needs a provider query that asks for the children of one item
(`?labels=parent::…`), which is a change to the catalog API rather than to
the scheduler. The alternative — reading the membership from AFK's local
mirror — was rejected: the mirror is a cache, and a stale membership would
hold back work that is actually fine.

## Alternatives considered

- **Keep the platform-wide check and make the threshold smaller.** Rejected:
  there is no threshold. One broken project out of forty-six is already
  noise, and one broken project out of two is not.
- **Read only the projects of the scope.** Rejected for now: the scope's
  membership is discovered *through* the relationships, and a slice that
  lives in another repository is found by reading that repository. A
  read-only-the-scope scheduler would have to know the membership before it
  reads, which is the problem above. The read stays platform-wide; only the
  *judgement* is scoped.
- **Ignore out-of-scope diagnostics silently.** Rejected: silence is what
  made the original defect invisible. The failure is reported by name; it is
  only the *consequence* that changed.
- **Treat an in-scope failure as fatal for the whole tree.** Rejected: it is
  the same mistake one level down. The information that is missing is
  item-level, so the consequence is item-level too.
- **Write `blocked` and `hitl` to the affected items in the provider.**
  Rejected: the items of an unreadable repository cannot be read, so they
  cannot be marked, and marking the visible ones turns a read failure into a
  provider mutation. The escalation is a visible report instead.
- **Retry an in-scope failure that cannot be retried, forever.** Rejected:
  that is the old behaviour's worst half. A repository that is gone needs a
  person, not a timer.
