---
name: jev-agent-guard
description: >-
  Use when an agent needs to stay aligned with its active SKILL, minimize
  token waste, avoid looping execution paths, preserve compact context,
  and protect the workspace from destructive, credential, network, or
  untrusted external actions. This guard applies local policy first and can
  call Jev/jev-axi as a second opinion only when the risk or ambiguity is
  high enough to justify it.
license: MIT
compatibility: Requires Node.js 18+; host-specific Hook adapters are optional.
metadata:
  author: easyhaloo
  version: "1.0"
---

# Jev Agent Guard

**Goal:** keep the agent compliant with its active Skill, stop drift early,
reduce token burn, preserve a compact context window, and block dangerous
operations before they happen.

## Core policy

1. Respect the active Skill's required steps and hard constraints.
2. Fail closed for destructive, credential, untrusted external, or policy-changing actions.
3. Prefer local, deterministic checks before calling Jev or any remote evaluator.
4. Use Jev only for ambiguous, high-value semantic judgments, not for every tool call.
5. Keep context compact, recent, and directly relevant to the current goal.
6. Stop when the agent is looping, regressing, or continuing without new evidence.

## What this skill checks

- Skill compliance: are we following the currently active behavior contract?
- Token efficiency: are we burning tokens without proportional progress?
- Execution trajectory: are we repeating edits, retries, or wrong assumptions?
- Context quality: are we carrying stale, redundant, or unrelated artifacts?
- Permission safety: are we about to read secrets, mutate git state, or run dangerous commands?

## Boundaries

- This skill does not replace the host's native approval flow.
- It does not silently grant permission to a high-risk action.
- It does not auto-run destructive recovery commands.
- It does not call Jev for every ordinary read or a trivial local test.

## Decision model

The guard emits structured decisions in a shared protocol:

- `allow`: continue normally
- `confirm`: ask for explicit user approval
- `warn`: continue but with a corrective recommendation
- `redirect`: stop the current path and return to the missing or broken step
- `compact`: cut stale context and keep only the high-value artifacts
- `deny`: block execution now
- `block`: block with a stronger fail-closed signal

## Steps

1. Normalize the incoming tool or hook payload.
2. Classify the action by intent and risk.
3. Check Skill compliance against the active workflow.
4. Run local token, trajectory, and context checks.
5. If uncertainty remains and the action is high value, call Jev/jev-axi as a second opinion.
6. Return the structured decision and the exact corrective action.
7. Record a redacted audit entry only after the decision.

## Permission safety rules

Default outcomes:

- local read, project file read, or documented repo check → allow
- edit in the current workspace → allow, but keep scope narrow
- test or lint command in the repo → allow
- arbitrary shell command or unreviewed script → confirm or deny
- network request → confirm
- secret access → deny
- destructive git operations → deny
- external-code download and execution → deny
- policy or CI configuration mutation → confirm or deny depending on scope

## Token budget rules

- Keep the last relevant facts and discard stale duplicates.
- Summarize very long outputs instead of replaying full logs.
- Drop superseded search results and repeated command output.
- Retain the user objective, validation failures, current diff, and last successful signal.
- If the context is above ~75% of the effective limit, compact aggressively.

## Trajectory rules

Intervene when the agent shows any of the following:

- same file edited repeatedly with no new evidence
- same failed command retried without a new hypothesis
- repeated changes to the same code path after repeated failure
- expanding scope without new requirements
- no verification after a meaningful code change
- multiple contradictory assumptions without a resolution

When such signals occur, return `redirect` or `compact` and stop the loop.

## Context rules

- Preserve user requirements, acceptance criteria, constraints, and the current diff.
- Keep the latest failure message and its most relevant stack trace.
- Collapse repeated tool calls into one state summary when possible.
- Remove stale logs once a newer result supersedes them.
- Prefer recent, high-relevance artifacts over old broad context.

## Host integration

The skill is designed to work with Claude Code, Codex, and OpenCode.
The actual host-specific behaviors live in adapter scripts under
`skills/jev-agent-guard/scripts/adapters/` and are invoked by the guard
before or after tool runs.

## Caveats

- MUST NOT treat a Jev response as a substitute for user confirmation.
- MUST NOT auto-approve destructive or credential-related actions.
- MUST NOT silently bypass native host policy.
- MUST NOT widen scope after a failure without new evidence.
- MUST NOT continue a loop if the last action added no verified progress.
