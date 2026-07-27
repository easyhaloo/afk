# Hard Checks

Non-negotiable rules. Violating any of these is grounds for immediate
escalation to `mode::hitl` — not a warning, not a retry.

---

## Hard Rules

### HC-1: No secret in any commit

A secret (API key, token, password, private key, credentials in plain
text) that lands in any WIP commit is **unrecoverable**. Git history
retains it even after a subsequent "fix" commit.

**Rule:** Do not read files outside `.env.fork` for credentials.
Do not run commands that echo credentials into commit messages.
If a credential is accidentally committed, treat it as a security
incident — stop, escalate, do not continue the run.

### HC-2: Test before implementation (for feature tasks)

Every new feature behavior must have a failing test **before** any
implementation code for that behavior exists. A commit that contains
only implementation with no test code for the same behavior is
non-compliant on a feature task.

**Rule:** Red → Green → Refactor. Never skip Red.

### HC-3: Evidence must be observable output, not code

The `Progress:` checklist's evidence column must contain **observable
runtime output** — actual command output, API responses, test results,
log lines, or screen state. It must NOT contain a description of what
code was written.

**Compliant evidence examples:**
- `curl ... returned 200 + {"order_id": "ord-123"}`
- `pnpm test src/foo.test.ts → 3 passing`
- `POST /api/v1/orders → 201; GET /api/v1/orders/ord-123 → 404 (not created)`
- `interface SnapshotRepo { FindByBindingAndDocID(...) }` — only when the
  AC is "define interface X" (code itself is the artifact)

**Non-compliant evidence (code as artifact):**
- "implemented the handler"
- "added repository methods"
- "test passes" (without showing the actual test output)

**Rule:** If the only evidence of an AC being done is that code was
written, that AC is not done. Run the code and capture its output.

### HC-4: AC completeness check before Step 8

Before opening the MR (Step 8), every AC line must be checked off in
the Progress checklist with real evidence. `/goal` announcing done is
not evidence.

**Rule:** If any AC line is unchecked or has no observable-output
evidence, do not proceed to Step 8. Add a WIP commit that marks the
missing lines and the `Next:` describes what is needed.

### HC-5: No destructive operations on shared infrastructure

`main-down`, `fork --destroy`, `docker compose down -v`, `git clean
-fdx` on the main repo — none of these are ever permitted in an AFK
run. Only operations scoped to the issue's worktree or its DB fork are
allowed.

**Rule:** Any destructive command must be confirmed to target only
`.worktrees/issue-<iid>` or the issue's named fork, not the shared
development environment.

### HC-6: No force-push to the issue branch

Force-pushing the issue branch rewrites history and destroys the
checkpoint trail that `Next:` lines depend on.

**Rule:** `git push --force` on `afk/issue-<iid>` is prohibited.
Use regular push only.

### HC-7: Retry count is not in worktree git config

Storing retry count in the worktree's `.git/config` means it is lost
if the worktree is removed or recreated. The retry count must survive
worktree deletion.

**Rule:** Retry state is stored in the GitLab issue label or comment,
not in any worktree-local file.

---

## Escalation Protocol

When a hard check is violated:

1. Do not continue the run.
2. Post a GitLab comment describing which HC was violated.
3. Relabel the issue `mode::hitl`.
4. Detach from tmux and stop the session.

The human owns the recovery decision.
