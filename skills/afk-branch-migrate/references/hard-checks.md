# Hard Checks

Non-negotiable rules inherited from `afk-do`. Violating any of these
is grounds for immediate escalation to HITL mode.

---

## HC-1: No secret in any commit

**Rule:** Do not read files outside `.env.fork` for credentials. Do not
run commands that echo credentials into commit messages.

---

## HC-2: Test before implementation (N/A for this skill)

This skill is a workflow orchestrator, not a feature implementation.
HC-2 does not apply.

---

## HC-3: Evidence must be observable output

The `Progress:` checklist's evidence column must contain **observable
runtime output** — git output, diffs, conflict markers, or command
results. It must NOT contain a description of what code was written.

---

## HC-5: No destructive operations on shared infrastructure

Destructive commands (`git clean -fdx`, `git reset --hard` on main,
etc.) must be scoped to the worktree or explicitly confirmed.

**Rule:** Any destructive command must be confirmed to target only the
current worktree or the backup checkpoint, not the shared repo.

---

## HC-6: No force-push

Force-pushing (`git push --force`) is prohibited. Use regular push only.

---

## HC-Skill-1: No external API calls

This skill MUST NOT call GitLab, GitHub, or any external API. All
operations use local Git commands only.

## HC-Skill-2: Always create rollback checkpoint

Before applying any change, MUST create a backup branch. If this step
is skipped, escalation to HITL is required.

## HC-Skill-3: High/Critical conflicts require explicit confirmation

Auto-resolving High or Critical conflict risk files is prohibited.
Every such conflict requires a separate user confirmation.
