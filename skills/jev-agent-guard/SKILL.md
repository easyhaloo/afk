---
name: jev-agent-guard
description: >-
  Use when an agent needs runtime supervision for Skill compliance, semantic
  action risk, token-efficient context retention, execution-loop detection,
  and evidence-based completion. This Skill uses local normalized runtime
  state and the official TypeSafe Jev SDK for typed semantic judgments.
license: MIT
compatibility: Requires Node.js 20+ and the Skill-local @typesafe-ai/sdk dependency; live Jev calls require TYPESAFE_API_KEY.
metadata:
  author: easyhaloo
  version: "1.4"
---

# Jev Agent Guard

**Goal:** supervise an agent during execution by using Jev semantic judgments to improve action safety, trajectory quality, context retention, Skill compliance, and completion correctness.

## Operating model

This Skill contains semantic rules only. It does not contain host-specific policy. Claude Code, Codex, and OpenCode adapters must normalize their events into the same runtime state before calling this Skill.

Use the official `@typesafe-ai/sdk` through `scripts/jev-client.mjs`. Do not add a custom HTTP transport.

## Runtime loop

1. Receive a normalized `before-action`, `after-action`, `context-review`, or `stop` state.
2. Select only the semantic rule relevant to the event.
3. Send one compact state with batched typed `Choice`, `Score`, and `Noul` questions.
4. Convert the typed answer through the local semantic engine.
5. Return `allow`, `confirm`, `deny`, `redirect`, `compact`, `keep`, `truncate`, `drop`, or `finish`.
6. Let the host adapter map that decision into its native hook response.

## Semantic rule groups

- `action-risk`: judge ambiguous action risk and handling.
- `trajectory-state`: judge whether the agent is stuck and choose a focused next step.
- `context-retention`: judge whether a context item should be kept, truncated, or dropped.
- `skill-compliance`: judge whether the active Skill contract and completion conditions are satisfied.

Rules are stored in `rules/semantic.json`. Keep them host-neutral. Do not add Claude Code, Codex, OpenCode, hook names, or provider-specific event fields to the rule file.

## When to call Jev

Call Jev only for semantic uncertainty:

- an action is not resolved by deterministic application logic
- the agent may be looping or changing the wrong location
- context is under pressure and retention is ambiguous
- completion evidence is incomplete or contradictory
- Skill compliance cannot be established from explicit state alone

Do not call Jev for every ordinary read, short test, or already-classified safe action.

## Runtime state to preserve

Keep the state compact and explicit:

- user goal and acceptance criteria
- active Skill names and required steps
- current action and bounded target
- recent failures and error signatures
- same-command and same-failure counts
- changed files and current diff summary
- context usage and candidate context item
- latest validation command and result

Do not send secrets, private keys, raw environment files, credentials, or unrelated private source to Jev.

## Decision handling

- `deny` and `confirm` never authorize execution.
- `redirect` must include a concrete next action such as `change_hypothesis`, `inspect_failure`, or `run_narrow_test`.
- `compact` must retain the goal, constraints, current diff, latest failure, and last successful evidence.
- `finish` is valid only when validation and Skill completion evidence are present.
- Jev failure is not approval; return to host-native approval or fail closed for high-impact actions.

## Caveats

- MUST NOT add host-specific rules to `rules/semantic.json`.
- MUST NOT use Jev as a replacement for authorization or user confirmation.
- MUST NOT let a semantic answer execute a side effect directly.
- MUST NOT continue a repeated failure path without new evidence.
- MUST NOT finish after edits without relevant validation and final diff review.
