---
name: afk-pipeline
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

## Routing

Pick the row that matches what the user has in hand right now:

| User has... | Invoke |
|---|---|
| An idea or feature, nothing written | `/afk-grill-me` |
| An approved `CONTEXT.md` | `/afk-to-prd` |
| An approved `PRD.md` | `/afk-to-issues` |
| A GitLab issue to implement | `/afk-implement <iid>` |
| Multiple issues to orchestrate | `/afk-scheduler` |
| A specific task in *this* session | `/afk-do "<task>"` |
| An MR to verify | `/afk-qa <mr-url>` |

If multiple rows match, ask which to act on — do not pick silently.

## Pipeline order

```
            ┌─→ /afk-prototype  (optional, technical risk spike)
            │
grill-me → to-prd → to-issues ─┬─→ implement ─┐─→ qa
                                └─→ scheduler ──┘
```

- `grill-me` is required for new work.
- `prototype` is recommended when technical risk or unknowns exist.
- `implement` does one issue; `scheduler` does many in DAG order.
- `qa` is the merge gate.
