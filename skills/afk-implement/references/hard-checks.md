# Hard Checks

Non-negotiable. Any violation stops the run immediately: record which HC
was violated, transition the backlog to canonical `blocked` with
`executionMode: hitl`. Not a warning. Not a retry.

| ID | Rule |
|----|------|
| HC-1 | No secret in any commit. Read credentials only from `.env.fork`. A leak is a security incident — stop and escalate. |
| HC-2 | Feature tasks: failing test exists before implementation code for that behavior (Red before Green). |
| HC-3 | Progress evidence must be observable runtime output (command result, API response, test log), not a description of code written. |
| HC-4 | Before publishing a change, every Acceptance Criteria line is checked with real evidence. |
| HC-5 | No destructive operations on shared infrastructure. Scope only to the backlog worktree or its named fork. |
| HC-6 | No force-push to the backlog branch. Preserve the checkpoint trail. |
| HC-7 | Retry count lives in the provider-neutral backlog execution record, never in worktree-local git config. |

## Escalation

1. Stop the run.
2. Append an execution record naming the violated HC.
3. Atomically set `state: blocked` and `executionMode: hitl`.
4. Detach. Human owns recovery (see `hard-checks-recovery.md`).
