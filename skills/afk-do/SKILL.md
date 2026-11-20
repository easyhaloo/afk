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
| Testing | `/afk-testing` | Test design, test-only changes, suite execution/diagnosis, or test-effectiveness audit |

## Testing task routing

When testing is the primary task, route to `/afk-testing` instead of
defaulting to feature TDD. For a dedicated legacy-coverage task that must not
change production behavior and requires a scoped plan/report, route to
`/afk-change-driven-testing`. A managed backlog item already in
`verification` belongs to `/afk-qa`.

## Steps

### Step 1 — Branch and workspace strategy

**Question 1: Branch strategy**

Ask user which branch to use:
- **Current branch** (default): work on the existing branch
- **New branch from main**: create fresh branch from latest main/master (recommended for new features/fixes)
- **New branch from current**: create branch based on current branch (for sub-tasks)

If current branch selected: check `git status --short` first. Uncommitted changes must be committed or stashed before proceeding.

**Question 2: Workspace (if creating new branch)**

Ask user where to work:
- **Current directory**: create branch in current working directory
- **Isolated worktree** (recommended): create `git worktree` under `.worktrees/<branch-name>/`

Worktree benefits: keeps main workspace clean, supports parallel work, easy cleanup.

**Question 3: Branch name (if creating new branch)**

Suggest branch name based on task type detected in Step 2:
- Feature → `feat/<description>` (e.g., `feat/user-login`)
- Refactor → `refactor/<description>` (e.g., `refactor/extract-validation`)
- Hotfix → `hotfix/<description>` (e.g., `hotfix/null-pointer-fix`)
- Spike → `spike/<description>` (e.g., `spike/graphql-feasibility`)

User can accept suggestion or provide custom name.

**Execution:**
```bash
# For "new branch from main" + "isolated worktree"
git fetch origin
git worktree add -b <branch-name> .worktrees/<branch-name> origin/main

# For "new branch from current" + "isolated worktree"
git worktree add -b <branch-name> .worktrees/<branch-name> HEAD

# For new branch in current directory
git checkout -b <branch-name> [origin/main|HEAD]
```

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
