---
name: jev-agent-guard
description: >-
  Runtime semantic supervision for agent actions, execution trajectory,
  context retention, Skill compliance, and evidence-based completion using
  the official TypeSafe Jev SDK.
license: MIT
compatibility: Requires Node.js 20+, the local @typesafe-ai/sdk dependency, and TYPESAFE_API_KEY for live evaluation.
metadata:
  author: easyhaloo
  version: "1.5"
---

# Jev Agent Guard

## One-click install

From the repository root:

```bash
export TYPESAFE_API_KEY="your-key"
node skills/jev-agent-guard/scripts/install.mjs
```

Use `--dry-run` to preview changes or `--host=claude-code,codex,opencode` to
select hosts. The installer installs the official SDK locally and adds only
idempotent, marked entries to host configuration.

## Runtime behavior

Adapters normalize host events and invoke the host-neutral semantic engine:

- `before-action` → action risk
- `after-action` → trajectory state
- `context-review` → context retention
- `stop` → Skill compliance

The Skill can return `allow`, `confirm`, `deny`, `redirect`, `warn`, `compact`,
`keep`, `truncate`, `drop`, or `finish`. It never executes a side effect and
never treats Jev as a substitute for user approval.

## Safety and privacy

Send only compact, relevant runtime state. Never send API keys, credentials,
private keys, complete environment files, or unrelated private source. Jev
unavailability is not approval: pre-action and stop checks fail closed to
`confirm`.

Rules remain in `rules/semantic.json` and contain no host-specific fields.
