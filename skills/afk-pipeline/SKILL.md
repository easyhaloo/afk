---
name: afk-pipeline
disable-model-invocation: true
description: >-
  Use when the user is unsure which phase skill to invoke, or asks for
  the lifecycle overview. Recommends the appropriate skill based on
  current workflow stage.
disallowed-tools: >-
  Edit(*) Write(*) Agent(*) Task*(*)
  Bash(git push*) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*)
---

# Pipeline — Routing

**Goal:** route user intent to the right phase skill.
**Mode:** HITL — clarify which skill applies; never auto-launch.
**Contract:** user intent → recommended phase skill invocation.

> **Note:** this skill is a navigation guide — it references other
> skills by name to help users find the right entry point. It does NOT
> invoke them itself; each listed skill is independently usable.

## Routing

Pick the row that matches what the user has in hand right now:

| User has... | Invoke |
|---|---|
| An idea or feature, nothing written | `/afk-grill-me` |
| A bounded context, architecture doc, or code audit already exists | `/afk-grill-me-context` |
| An idea with technical risk to validate first | `/afk-prototype` |
| An alignment record (interview, draft, requirements) | `/afk-to-prd` |
| An approved PRD | `/afk-to-issues` |
| A ready backlog item to implement | `/afk-implement <backlog-id>` |
| Multiple backlogs to orchestrate | `/afk-scheduler` (starts `afk loop`) |
| A specific task in *this* session | `/afk-do "<task>"` |
| A backlog in verification | `/afk-qa --backlog-id <backlog-id>` |
| A reproducible failure to diagnose | `/afk-diagnose` |
| Session state to snapshot or resume | `/afk-hand-off` |

If multiple rows match, ask which to act on — do not pick silently.

## Pipeline order

A typical flow — each stage has an alternative entry point shown in
the routing table above:

```
grill-me-context → grill-me → prototype (optional) → to-prd → to-issues
                                                          │
                                              ┌───────────────┤
                                              ↓               ↓
                                          implement       scheduler
                                              │               │
                                              └───────┬───────┘
                                                      ↓
                                                      qa
```

- `grill-me` (or `grill-me-context`) is the start for new work.
- `prototype` is recommended when technical risk exists.
- `implement` executes one backlog; `scheduler` starts the loop for many
  provider-backed backlogs in dependency order.
- `qa` is the merge gate.
- `do`, `debug`, `hand-off` are session-local utilities, off the pipeline.
