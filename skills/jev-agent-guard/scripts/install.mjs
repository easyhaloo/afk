---
name: jev-agent-guard
description: >-
  Use when an agent needs to stay aligned with its active SKILL, minimize
  token waste, avoid looping execution paths, preserve compact context,
  protect the workspace, or obtain a bounded semantic judgment from the
  official TypeSafe Jev SDK before a high-value ambiguous decision.
license: MIT
compatibility: Requires Node.js 20+ and the Skill-local @typesafe-ai/sdk dependency; live Jev calls require TYPESAFE_API_KEY.
metadata:
  author: easyhaloo
  version: "1.3"
---

# Jev Agent Guard

**Goal:** keep the agent compliant with its active Skill, stop drift early,
reduce token burn, preserve compact context, and block dangerous operations.

## Quick install

From the repository root:

```bash
node skills/jev-agent-guard/scripts/install.mjs
```

This installs the host hooks for Claude Code and Codex, and creates a small
adapter layer that routes risk checks through the shared guard policy.

## Official SDK

Use the Skill-local `scripts/jev-client.mjs` facade, which calls the official
`@typesafe-ai/sdk` package and `TypeSafeClient.systemOne`. It exposes typed
`choice`, `noul`, and `score` questions. Do not add a custom HTTP client or a
second transport.

The dependency is declared in this Skill's `package.json`. The SDK reads
`TYPESAFE_API_KEY` from the process environment. Never store the key in the
repository, command arguments, state files, or audit output.

## Steps

1. Normalize the incoming tool or hook payload.
2. Classify the action by intent and risk.
3. Check Skill compliance against the active workflow.
4. Run local token, trajectory, context, and permission checks.
5. Call the official Jev SDK only when local rules cannot resolve a high-value semantic decision.
6. Return the shared structured decision and exact corrective action.
7. Record a redacted audit entry.

## Core rules

- Fail closed for destructive, credential, external-code, and unsafe policy actions.
- Never use Jev as a substitute for host approval or user confirmation.
- Keep the user objective, acceptance criteria, current diff, latest failure, and last successful checkpoint.
- Compact stale logs, repeated searches, superseded tool output, and unrelated files.
- Redirect after repeated failures, repeated edits without new evidence, scope expansion, or missing validation.
- Do not call Jev for ordinary local reads, short logs, or trivial project checks.

## Host integration

The Skill is designed for Claude Code, Codex, and OpenCode. Host-specific
adapters live under `scripts/adapters/`; shared policy and the native Jev SDK
facade remain inside this Skill directory.

## Host adapters

- `scripts/adapters/claude-code.mjs` — Claude Code pre-tool guard
- `scripts/adapters/codex.mjs` — Codex pre-tool guard
- `scripts/adapters/opencode.mjs` — OpenCode plugin-friendly wrapper

## Caveats

- MUST NOT transmit secrets or unredacted private data.
- MUST NOT auto-approve destructive or credential-related actions.
- MUST NOT silently bypass native host policy.
- MUST NOT continue a loop when the last action produced no verified progress.
