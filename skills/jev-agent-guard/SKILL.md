---
name: jev-agent-guard
description: >-
  Use when an agent needs to stay aligned with its active SKILL, minimize
  token waste, avoid looping execution paths, preserve compact context,
  protect the workspace, or obtain a bounded semantic judgment from the
  included Jev client before a high-value ambiguous decision.
license: MIT
compatibility: Requires Node.js 18+; live Jev calls require TYPESAFE_API_KEY.
metadata:
  author: easyhaloo
  version: "1.1"
---

# Jev Agent Guard

**Goal:** keep the agent compliant with its active Skill, stop drift early,
reduce token burn, preserve compact context, and block dangerous operations.

## Jev client

The Skill contains a dependency-free client at `scripts/jev-client.mjs`.
Internal scripts may import it directly. Use one batched request for related
semantic questions, redact input before transmission, and treat every provider
answer as advisory. `TYPESAFE_API_KEY` is never read from repository files or
written to configuration.

## Steps

1. Normalize the incoming tool or hook payload.
2. Classify the action by intent and risk.
3. Check Skill compliance against the active workflow.
4. Run local token, trajectory, context, and permission checks.
5. Call the included Jev client only when local rules cannot resolve a high-value semantic decision.
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
adapters live under `scripts/adapters/`; the shared policy and Jev transport
remain inside this Skill directory.

## Caveats

- MUST NOT transmit secrets or unredacted private data.
- MUST NOT auto-approve destructive or credential-related actions.
- MUST NOT silently bypass native host policy.
- MUST NOT continue a loop when the last action produced no verified progress.
