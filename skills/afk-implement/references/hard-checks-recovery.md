# Hard Checks Recovery (HITL)

Human-owned playbook after a hard-check violation. Agents do not execute
this during an AFK run. Prefer intent over copy-paste commands; adapt to
the repo and provider in use.

## Common outcomes

| HC | Intent of recovery |
|----|--------------------|
| HC-1 | Confirm leak scope; remove secret from history if not yet shared; rotate all exposed credentials; prevent recurrence (ignore patterns, secret scanning). |
| HC-2 | Ensure a failing test exists before implementation in history order; reorder or add the missing test, then re-verify Red then Green. |
| HC-3 | Replace narrative Progress lines with captured runtime output; attach artifacts via the provider when needed. |
| HC-4 | Complete every unchecked AC with observable evidence before publishing the change. |
| HC-5 | Assess shared-environment damage; restore from backup if needed; ensure future ops are worktree-scoped. |
| HC-6 | Prefer fetch + rebase over force-push; restore a linear checkpoint trail if history was rewritten. |
| HC-7 | Move retry state into the provider-neutral execution record; remove any worktree-local retry keys. |

## Resume

After remediation, transition the backlog to `ready` with `executionMode: afk`
through the configured provider, then re-run `afk run --backlog-id <id>`.
