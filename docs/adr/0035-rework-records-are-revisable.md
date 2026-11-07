# ADR-0035: A rework record is correctable

- Status: accepted
- Date: 2026-11-06

## Context

AFK keeps a structured record of every rework round. The record lives in the
backlog item's issue as a comment:

```
<!-- afk:rework:v1 id=r2 -->
## AFK Rework r2 · open

<the statement about what is wrong>

```json
{"source":"qa","summary":"…","failedCriteria":[…],"requiredChecks":[…],…}
```
```

The next agent reads that record as its context. It is told which acceptance
criteria failed, which checks it has to run, and — in the summary — what the
situation is.

AFK could create a record, supersede it with the next round, and resolve it.
It could not **correct** one. A record was frozen at the moment it was
written, and a frozen statement is read as a present fact.

Three records of PRD #27 show what that costs:

- `fang/services/aiapi#10` carried an open record `r2` from 2026-10-30 whose
  summary described the state of the world on that day. Two weeks later the
  record was still the first thing the agent read, and it described a
  dependency that had since produced its change request.
- `fang/services/k-base#7` carried an open record `r2` from 2026-10-29 whose
  summary said the item waits for the resolver of `k-base#3`. The resolver
  was produced; the record still said the item waits for it.
- `fang/services/k-base#9` had a record that mistook "the baseline moved
  because the agent's own commit advanced it" for "the change conflicts with
  `prd/27`". AFK therefore read a conflict into the platform's verdict and
  told the agent to *merge the target branch into the current branch and
  resolve the conflicts*. The agent pushed a branch it did not own. The
  correction could only be made by editing the issue comment by hand, with
  `glab api PUT` — a provider edit made outside AFK, which is exactly what
  the repository's own rule forbids: *"Provider data changes go through the
  AFK CLI."*

The root cause is the same one the other reconciliation defects have
(ADR-0030, ADR-0031): AFK wrote down its own state and then treated that
state as the truth, instead of reading the truth back and reconciling.

## Decision

**A rework record is correctable: the statement is revised in place, the
evidence is not, and a correction is a fact rather than an instruction.**

### The command

```
afk backlog rework revise --id <backlog> --record <r2> --summary "<fact>" [--reason "<why>"]
```

`--id` names the backlog item, like every other `afk backlog` command.
`--record` names the rework record to correct (`r2`, `r1-2`, …). `--summary`
is the statement that replaces the record's summary, and `--reason` says why
it is being corrected.

The command is grouped under `rework` for the same reason `tag` and `relation`
are: a noun-scoped family of edits on one object, with the object named by
`--id` and the member named by its own flag. A flat `afk backlog
rework-revise` would have been shorter, and it would have made the next
member of the family (`rework resolve`, `rework show`) another rename.

### The identity of the record is kept

The correction replaces the summary **in the same record**: the same id, the
same cycle, the same attempt, the same comment.

The alternative was a new generation — a new record that supersedes the old
one. It was rejected for a reason that has nothing to do with taste: the
attempt of a new record is derived from the records of the running cycle, so
a new generation **spends an attempt of the round's rework budget**. Saying
"this is still true today" would have cost the item one try less to actually
fix it. A correction that changes what the agent is told must not change what
the agent is allowed to do.

Keeping the identity has a second consequence: the record's handle stays the
same, so the prompt that names it (`An open QA rework record (r2, cycle 1,
attempt 2) applies to this backlog`) keeps pointing at the same round.

### The evidence is not touched

`failedCriteria` and `requiredChecks` are what the verification actually
observed. A correction says "this is still true today", not "this was never
true", so the evidence is never rewritten and never dropped. Only the
statement about the current situation is replaced.

### The correction is a fact, not an instruction

The record is read by an agent. A statement that carries an instruction is an
instruction the agent will follow — and the old conflict wording is what
turned a mistaken verdict into an unauthorized push.

A revision is therefore refused when it carries one of the directive shapes
that caused the incident:

- a branch named as the destination of a push or a publish (`publish to
  prd/27`, `push to main`, `发布到 prd/27`);
- a branch named as the source of a merge into another branch (`把 prd/27 合进
  当前分支`, `merge the target branch into the current branch`);
- a git command that moves a branch;
- a command that merges or re-runs work (`afk backlog confirm-merge`, `afk
  backlog retry`, `glab api`).

This is a denylist of concrete shapes, not a general detector of imperatives.
A general detector cannot tell `把依赖写成了 label` (a fact) from `把 prd/27 合进当前分支`
(an instruction) without parsing the sentence, and a rule that guesses refuses
honest statements. The check runs before the provider is touched, so a
statement that carries a directive never reaches the provider at all.

### The correction leaves a trail

The record carries its own revisions: when the correction was written, who
wrote it, what the statement was before, and what it is now. The rendered
comment shows the same trail in prose, so a reader of the issue does not have
to parse the payload to find out that the statement was corrected.

A correction that does not say who made it is a silent overwrite.

## Consequences

- A stale statement can be corrected without spending a rework attempt, and
  the agent reads the corrected statement on the next run: the record is
  corrected in place, so the read path (`getActiveRework` →
  `formatReworkContext`) returns the new summary and the old one is no
  longer what the agent is told.
- The provider write goes through AFK's own provider abstraction, so a
  correction no longer needs `glab api PUT` and no longer leaves provider
  data outside AFK.
- A record that has been corrected still carries the evidence of the round
  that failed, and the correction trail says what the statement used to say.
- The statement of a record is now AFK's own editable state. The rule that
  follows from this ADR is the one the repository already states for every
  other piece of AFK state: write state after reading the fact.

## Alternatives considered

- **Let a person edit the issue comment by hand.** Rejected: it is what
  happened, and it is what the repository forbids. A provider edit the CLI
  does not support is a gap in the CLI.
- **Open a new generation of the record for every correction.** Rejected: it
  spends an attempt of the running cycle's rework budget, so correcting a
  statement would cost the item a try.
- **Let the agent correct its own record.** Rejected: the agent is the party
  the correction exists for, and an agent that can rewrite the failure
  report has no failure report.
- **Refuse any revision whose text contains a branch name.** Rejected: the
  facts a correction has to state are facts about branches and change
  requests. The rule that matters is that a branch must not be named as the
  destination of an action.
