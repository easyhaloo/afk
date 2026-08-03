---
name: afk-do
description: >-
  Use when user requests a specific coding task to execute in the current
  session (e.g. "帮我完成 X", "add login", "fix null pointer").
  HITL execution within the session. Optional escalation to background
  execution upon completion.
disable-model-invocation: false
disallowed-tools: >-
  Bash(git push*) Bash(git reset --hard*) Bash(git branch -D*)
  Bash(docker rm*) Bash(docker rmi*) Bash(rm -rf*)
---

# Do (Direct execution in current session)

**Goal:** accomplish the user's stated task using the current session's
full context, applying the appropriate development methodology.
**Mode:** HITL — user can interrupt, redirect, or deepen at any time.
**Contract:** natural-language task → completed work in current session.
**Workspace:** current branch (default) or isolated worktree.

## Preconditions

None — activates on conversational request.

## Task type detection

Before writing any code, determine the task type:

| Task type | Reference | When to use |
|-----------|-----------|-------------|
| Feature | `tdd-feature.md` | New behavior: API, data model, UI |
| Refactor | `tdd-refactor.md` | Structure change, no behavior change |
| Hotfix | `hotfix.md` | Live production bug under pressure |
| Spike | `spike.md` | Feasibility exploration |
| Research | `research.md` | Information gathering or decision-making |

## Steps

### Step 1 — Workspace mode

Ask user which workspace mode to use:
- **Current branch** (default): work directly in the current directory.
- **New worktree**: create isolated `git worktree` under `.worktrees/do-<name>/`.

If current branch: check `git status --short` first. Uncommitted changes
must be committed or stashed before proceeding.

### Step 2 — Load methodology

1. Read `references/README.md` — apply the task-type detection prompt.
2. Read `references/<type>.md` — the methodology for the detected type.
3. Read `references/hard-checks.md` — non-negotiable rules.

Do not skip Step 2. A run that jumps straight to code is non-compliant.

### Step 3 — Plan

Before writing code, outline:
- What files will be touched
- What the acceptance criteria are
- What existing tests cover the area

Present the plan to the user briefly and confirm direction.

### Step 4 — Execute

Follow the methodology from Step 2. Commit at natural checkpoints:

| Prefix | When |
|--------|------|
| `feat:` | New feature, API, data model, UI |
| `fix:` | Bug fix |
| `refactor:` | Code restructure, no behavior change |
| `hotfix:` | Production patch |
| `spike:` | Feasibility exploration |
| `wip:` | Work-in-progress checkpoint |

### Step 5 — Verify

Run relevant tests, verify the change compiles or passes lint,
confirm no regression in the affected area.

### Step 6 — Done

Present the result. User accepts → task is complete.
User wants more → continue in current session.

## Parallel execution

Fan out **independent items** to parallel workers when:
- No shared state or types between modules
- Frontend / backend split, or feature + tests + types can proceed independently

Dependency patterns: `A → B` (B blocked by A); `A | B | C` (all unblocked).

Note: hidden coupling → serial when in doubt.

## Caveats

- MUST NOT skip Step 2 — methodology load is non-negotiable.
- MUST NOT push directly to protected branches.
- MUST NOT produce partial work without a clear "next action".
- MUST NOT leave a worktree hanging after the session ends.
- MUST NOT parallelize when modules have hidden coupling — serial is safer.
