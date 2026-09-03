---
name: afk-scheduler
description: >-
  Use when multiple backlog items need dependency-aware autonomous
  execution. Plans runnable waves and starts the provider-backed loop.
disable-model-invocation: true
disallowed-tools: >-
  Edit(*) Write(*) Agent(*) Task*(*)
  Bash(git push*) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
---

# Scheduler

**Goal:** coordinate autonomous execution of backlog items based on their
`dependsOn` DAG — runnable items are claimed by the loop and blocked items
wait until dependencies complete.
**Mode:** AFK — `executionMode: afk` items are eligible; human items remain
`executionMode: hitl`.
**Contract:** provider-backed ready backlog → `afk loop` worker.

## Two invocation modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Manual** | `/afk-scheduler` (no args) | Show wave plan, ask confirmation, launch |
| **Auto** | `/afk-scheduler auto` | Idempotent scan, start the provider-backed loop |

## Concepts

**Wave:** a set of backlogs whose dependencies are already `done` and
which can be claimed in parallel. Wave 1 launches first; Wave N+1 becomes
runnable only after its dependencies complete.

**Example:**
```
Wave 1 (parallel): backlog-a, backlog-b — no dependencies
Wave 2 (after wave 1): backlog-c — depends on a, b
Wave 3 (after wave 2): backlog-d — depends on c
```

## Preconditions

1. The configured `BacklogProvider` is available and initialized.
2. At least one backlog is `state: ready`, `executionMode: afk`, and has
   completed dependencies (`afk backlog list --state ready --mode afk`).
3. The provider exposes atomic claim; there is no process-local fallback.

## Auto Mode (`/afk-scheduler auto`)

Idempotent — safe to re-run. Each run:
1. Scan provider backlogs with `state: ready` and `executionMode: afk`.
2. Filter out items with unresolved `dependsOn` or with incomplete children
   that make the item itself a grouping backlog. A child `parentId` alone is
   organizational metadata and does not make that child non-runnable.
3. Leave `in_progress`, `verification`, `merge_ready`, `done`, and `blocked`
   items to their current workflow; do not re-claim them.
4. Start the single provider-backed loop; it claims runnable items atomically
   and runs implementation → QA → merge → done.
5. Use loop status/log output for visibility.

Skip wave plan confirmation — the loop claims each runnable backlog atomically.

## Steps

### Step 1 — Build the dependency DAG

Construct DAG: each backlog ID → set of IDs in its `dependsOn` list.

**Precondition:** provider initialized and AFK backlogs exist.
**Output:** dependency DAG.

### Step 2 — Compute waves (topological sort by layer)

Wave 1: zero open blockers. Wave N+1: all blockers in Wave 1..N.
Cyclic dependencies → STOP and report.

**Precondition:** DAG constructed.
**Output:** wave plan.

### Step 3 — Launch gate

Manual mode: show wave plan, ask confirmation before launching.
Auto mode: skip to Step 3.5 — idempotent, no confirmation.

### Step 3.5 — Auto mode: scan and launch

Run `afk loop --daemon` (or `afk loop` in the foreground). The loop handles
dependency checks, atomic claims, duplicate prevention, implementation, QA,
merge, and terminal state transitions.

For an isolated validation, pass every approved test item explicitly and bound
concurrency and completions:

```bash
afk loop --max-concurrent 1 --max-iterations <n> \
  --backlog-id <id-1> --backlog-id <id-2> \
  --agent <provider>
```

A validation run MUST include one or more `--backlog-id` values; never scan all
repository-ready items unless that broad scope was explicitly approved.

**Precondition:** auto mode selected.
**Output:** runnable backlogs available to the loop.

### Step 4 — Launch Wave N (manual mode)

Run the loop with an appropriate `--poll-interval` and
`--max-concurrent`; for an isolated wave test, also pass each item via repeated
`--backlog-id`. It advances to later waves as dependencies become
`done`; any conflict, timeout, automation failure, or non-pass QA result
becomes `blocked` + `hitl` while other runnable items continue.

**Output:** wave N launched.

### Step 5 — Completion

When all waves complete, report that all autonomous backlogs are `done` and
any `blocked`/`hitl` items require human intervention before release.

**Output:** completion signal.

## Caveats

- MUST NOT launch a backlog whose `dependsOn` item is not `done`.
- MUST NOT retry `blocked` backlogs without human decision — they require
  explicit recovery and `executionMode: hitl` handling.
- MUST NOT let the loop run without user visibility — use loop status and
  provider backlog state after each transition.
- MUST NOT delete remote branches — remote history is the audit trail.
- MUST NOT confuse an empty dependency list with a runnable item — grouping
  parents with incomplete children, non-AFK modes, and non-`ready` states are
  not launchable.
- MUST treat `parentId` as organizational only. Select an unmerged git base
  branch only when the backlog declares an explicit execution-base reference.
