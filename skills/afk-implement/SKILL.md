---
name: afk-implement
description: >-
  Use when a backlog item with machine-checkable Acceptance Criteria
  is ready for autonomous implementation. Produces a change request
  through the configured provider.
disable-model-invocation: true
disallowed-tools: >-
  Bash(git push origin main) Bash(git push origin master)
  Bash(git reset --hard*) Bash(git branch -D*)
---

# Implement

**Goal:** autonomously implement one backlog item with Acceptance Criteria.
**Mode:** AFK — the backlog item must have `executionMode: afk`.
**Contract:** runnable backlog (AC present, dependencies complete, no parent
execution) → change request and `verification`/`merge_ready`; any automation
failure escalates to canonical `blocked` state with `executionMode: hitl`.

## Preconditions (fail-closed)

All checks are mandatory. Stop immediately if any fails.

1. **The backlog description has an `## Acceptance Criteria` section with the 3-field format.**
   Each AC line: `- [ ] <text> -- <evidence_type> -- <check_command>`.
   Missing or malformed → backlog is not ready, stop.
2. **AC lines are machine-verifiable.** Every AC's `check_command` must
   be a shell command with exit-code contract (0 = PASS). If any AC
   has `evidence_type: manual`, treat it as a gate requiring human
   signoff, not autonomous verification.
3. **All dependencies are complete.** Use the provider's `dependsOn` field;
   every referenced backlog must be `done`. If a dependency is unresolved,
   stop without attempting execution.
4. **The item is runnable.** Confirm `state: ready`, `executionMode: afk`,
   and no `parentId` that makes this a grouping backlog. Claiming is atomic;
   a lost claim means another worker owns the item, so stop.

## Routing

| File | Read when |
|------|-----------|
| `references/README.md` | Before writing any code |
| `references/tdd-feature.md` | Feature, API, data model, or UI work |
| `references/tdd-refactor.md` | Code-structure improvement |
| `references/hotfix.md` | Live bug fix |
| `references/spike.md` | Feasibility exploration |
| `references/research.md` | Research / information-gathering |
| `references/hard-checks.md` | **Always** — non-negotiable rules |
| `references/ddd.md` | Conditional: complex domain invariants or cross-context flows |
| `references/architecture.md` | Conditional: new module/package or new external dependency |
| `references/adr.md` | Conditional: significant new decision during implementation |

## Development methodology

Every run starts by identifying the task type, then loading the
corresponding reference document.

Task type detection: ADD behavior → Feature; CHANGE structure → Refactor;
FIND information → Research; FIX bug → Hotfix; PROVE feasibility → Spike.

If unsure, default to `references/tdd-feature.md`.

## Progress checkpoints

Git commit is the SSOT. Every WIP commit must track: done count, total
count, Progress lines per AC, Next action trailer. `Next:` MUST be the
last paragraph of the commit body.

## Steps

### Step 1 — Pre-flight checks

Run Preconditions block against the backlog. Fail-fast on any violation.

### Step 2 — Launch

Invoke `afk run --backlog-id <id>`. The command claims the item through the
provider, executes the implementation workflow, and returns when it reaches
verification/merge-ready or a terminal failure.

### Step 3 — Methodology load (mandatory, before any code)

Before writing any code:
1. Read `references/README.md`
2. Read the corresponding `references/<type>.md`
3. Read `references/hard-checks.md`
4. Conditional reads per the Routing table

### Step 4 — Takeover (human-in-the-loop, optional)

Attach to the tmux session, read `git log --oneline -5` in the worktree.
The `Next:` line outranks any guess. Then `/goal pause`, manual work,
`/goal resume`, detach.

### Step 5 — Escalation on repeated failure

After exhausting retries, the runner transitions the backlog to canonical
`blocked` and `executionMode: hitl`, then exits. Do not edit provider labels
directly; those are adapter-owned persistence details.
Attach, read the last `Next:` line, decide:
- **Extend budget** — re-run with higher retry count
- **Correct course** — manually fix and add a fresh WIP commit
- **Escalate** — already done; a human may move the item back to `ready` and
  set `executionMode: afk` only after correcting the cause.

## Common failure modes

- **Target branch moved:** agent rebases before opening the change request.
- **Flaky vs. real failure:** different errors on two consecutive attempts
  → flaky, rerun. Identical failure twice → fix the cause.
- **Self-reported completion is not evidence:** if Progress checklist
  does not show every AC line with evidence, MUST NOT proceed to the change request.
- **Secrets discipline:** a secret in a WIP commit is unrecoverable —
  never read credential files beyond `.env.fork`.

## Caveats

- MUST NOT hand-write a `while true; do claude -p ...; done` loop.
- MUST NOT bypass `afk run --backlog-id` and reimplement its steps in bash.
- MUST NOT push directly to a protected branch — use the provider change request.
- MUST NOT treat comments as the sole progress record — WIP
  commit `Next:` trailer is the real handoff document.
- MUST NOT squash/rewrite WIP commit history before the change request.
- MUST NOT skip Step 3 — TDD methodology is not optional.
- MUST NOT delete remote branches — remote history is the audit trail.
- MUST NOT leave a tmux session hanging without idle detection.
- MUST NOT write an empty `Next:` trailer.
