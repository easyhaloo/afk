---
name: afk-scheduler
description: >-
  Use when multiple issues need to run in background sessions with
  dependency-aware ordering. Reads blocked_by DAG, launches unblocked
  issues in parallel waves.
disable-model-invocation: true
disallowed-tools: >-
  Edit(*) Write(*) Agent(*) Task*(*)
  Bash(git push*) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
---

# Scheduler

**Goal:** automate dispatch of background implementation sessions based
on the `blocked_by` dependency DAG — runnable issues launch immediately,
blocked issues launch when their blockers complete.
**Mode:** AFK — manages sessions autonomously once started.
**Contract:** open `mode::afk` issues → running sessions.

## Two invocation modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Manual** | `/afk-scheduler` (no args) | Show wave plan, ask confirmation, launch |
| **Auto** | `/afk-scheduler auto` | Idempotent scan, launch unblocked unrunning issues |

## Concepts

**Wave:** a set of issues that have no open blockers at the same time
and can run in parallel. Wave 1 launches first; Wave N+1 launches only
after all issues in Wave N have merged.

**Example:**
```
Wave 1 (parallel):  #2, #3   — no blockers
Wave 2 (after wave 1): #4   — blocked by #2, #3
Wave 3 (after wave 2): #5   — blocked by #4
```

## Preconditions

1. `glab` is authenticated.
2. At least one open issue with `mode::afk` and `stage::ready-for-issues`.
3. The `afk scheduler poll` command is available (ships with this skill).

## Auto Mode (`/afk-scheduler auto`)

Idempotent — safe to re-run. Each run:
1. Scan all `mode::afk` + `stage::ready-for-issues` issues.
2. Filter out open-blocker issues.
3. Filter out already running (`stage::afk-in-progress` or `stage::qa`).
4. Launch remaining issues in parallel tmux windows.
5. Post comment on each launched issue.

Skip wave plan confirmation — each issue launches immediately.

## Steps

### Step 1 — Build the blocked_by DAG

```bash
glab issue list --label "mode::afk" --state opened --output json | \
  jq '.[] | {iid, title, labels}'

# Blockers via label blocks-<iid>
glab issue list --label "blocks-<iid>" --output json | \
  jq -r '.[] | select(.state == "opened") | .iid'
```

Construct DAG: each issue → set of issue IIDs it is blocked by.

### Step 2 — Compute waves (topological sort by layer)

```
Wave 1: issues with zero open blockers
Wave 2: issues whose all blockers are in Wave 1
Wave 3: issues whose all blockers are in Wave 1+2
...
```

Cyclic dependencies → STOP and report.

### Step 3 — Launch gate

**Manual mode:** show wave plan, ask for confirmation before launching.

**Auto mode:** skip to Step 3.5 — idempotent, no confirmation.

### Step 3.5 — Auto mode: scan and launch

Run `afk scheduler poll`. Each unblocked, unrunning issue launches
immediately via `afk workflow run`.

```bash
afk scheduler poll --label mode::afk --label stage::ready-for-issues
```

For cron-based auto mode:

```cron
*/5 * * * * afk scheduler poll --label mode::afk --label stage::ready-for-issues
```

The `afk scheduler poll` command handles all preconditions (blocker check,
label filtering, duplicate detection) natively.

### Step 4 — Launch Wave N (manual mode)

Runs as autonomous loop. After launching Wave N:
1. Poll MR status every 60 seconds.
2. When all MRs in wave show `merged` → increment wave counter, sync
   base branch, launch next wave.
3. If any MR in the wave fails QA → STOP, notify human.

### Step 5 — Completion

When all waves complete:
```
All waves complete. Ready for final human gate:
  Merge prd/<N> → main
```

## Anti-patterns

- MUST NOT launch an issue whose open blocker is not yet merged.
- MUST NOT retry failed issues without human decision — escalate to
  `mode::hitl` after two failures.
- MUST NOT let the loop run without user visibility — post GitLab
  comment on each issue after every state transition.
- MUST NOT delete remote branches — remote history is the audit trail.
- MUST NOT confuse "no open blockers" with "no blockers at all" —
  only open blockers block launch.
