# Observability Harness Baseline

## Isolated branch

Harness work is isolated on `refactor/observability-harness` from commit
`309275f`. The main worktree retains pre-existing uncommitted desktop, backlog,
loop, sandbox, and runtime changes untouched. Existing backlog/loop semantic
repairs must land independently before any harness merge.

## Baseline verification

Full Vitest baseline was run in the isolated worktree before haFull Vitest baseline was run in the isolated worktree before haFull Vitest biles (16 tests),
all in pre-existing package-script, dashboard/node-pty, notification/node-pty,
or worktree-diagnostic scenarios. The full log is stored under
`.afk/refactor-baseline/vitest-baseline.log` and is not a harness regression.

## Characterization coverage require## Characterization coverage require## Characterization coverage require##ng parent/dependency/base semantics.
2. Claim conflicts, lease expiry, retry, rework, 2. Claim conflicts, lease expiry, retry, rework, 2. Claim conflicts, lease expit, resume, and failure cases.
4. QA pass/fail, temporary baseline behavior, PR/MR creation, and cleanup.
5. GitHub/GitLab state/mode/relationship mappings.
6. Loop scope, polling, max-iteration, graceful shutdown, and status output.
