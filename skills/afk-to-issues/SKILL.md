---
name: afk-to-issues
description: >-
  Decompose requirements into tracker issues with machine-checkable
  acceptance criteria. Two entry points: an approved PRD with
  Observable Behaviors, or any requirement context in Direct Mode.
  Reads the codebase to choose verification means (test runner,
  HTTP endpoint, log file, manual check).
disallowed-tools: >-
  Bash(afk mr merge*)
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(gh issue delete*) Bash(gh repo delete*)
  Bash(git push -f) Bash(git reset --hard*) Bash(git branch -D*)
---

# Requirements -> Issues

**Goal:** Independently pickable tracker issues with verifiable completion conditions.
**Mode:** HITL-gated — draft first, approve before creating.

## Slice Strategy (auto-infer, user confirms)

1. **Analyze** the requirement: count distinct domains, layers, and team ownership lines
2. **Infer** the best-fit strategy:
   - One team, end-to-end ownership → **Vertical** (default)
   - Multiple teams with layer ownership → **Horizontal**
   - Unclear or both viable → ask user to choose
3. **Tell** the user which strategy was chosen and why — only ask if both are genuinely viable

| Strategy | Shape | Best when |
|----------|-------|-----------|
| **Vertical** | model+API+logic+test in one package | Single team, fast delivery |
| **Horizontal** | one issue per layer (API, DB, UI) | Layer-owned teams, staged rollout |

## Input Paths

| Mode | Input | Path |
|------|-------|------|
| PRD Mode | `PRD.md` User Stories → Observable Behavior list | Full fidelity |
| Direct Mode | Any requirement context (free text / notes / chat) | Always available — MUST NOT skip |

## Verification Inference

For each Observable Behavior (or each requirement clause in Direct Mode),
read the codebase to infer:

1. **What proves the behavior** — locate:
   - Which test runner owns this layer (jest / vitest / mocha / pytest)
   - Which HTTP route handles this request
   - Which log line format this worker emits
   - Which file path / module name holds this state
2. **What `evidence_type` fits** — controlled vocabulary in
   `references/issue-template.md`: `test` | `curl` | `log` | `manual` | `none`
3. **What `check_command` exits 0 on PASS** — concrete shell snippet

Allowed tools: Read, Grep, Bash (read-only: ls, cat, grep, jq, find,
`afk issue list`, `afk mr list`). No mutating commands, no push, no delete.

If the codebase gives no signal for a behavior, default to `manual`
and flag it in the issue body as "needs automated check".

## Slicing Rules

- **Too big:** AC > ~5 lines, or touches > ~3 modules → split
- **Too small:** no user-observable behavior → fold into caller or mark tech-debt
- **Cycle check:** trace `blocked_by` graph; redraw boundaries if cyclic
- **Direct Mode:** ask user to narrow if requirement too large

## Steps

1. **Read inputs:** PRD or requirement context; read `references/issue-template.md` for AC schema
2. **Infer & slice:** read codebase → pick evidence_type per behavior → choose Vertical/Horizontal → slice
3. **Quality gate:** every AC has `-- <type> -- <command>`, command is runnable, evidence_type in vocabulary
4. **Create + HITL gate:** label with `stage::ready-for-issues,<mode>` + base, wire DAG via `afk issue link`, get approval before creating any

## References

| File | Read when |
|------|-----------|
| `references/issue-template.md` | Always — defines the AC schema you emit |

## Anti-patterns

- AC without `-- <evidence_type> -- <check_command>` suffix
- `evidence_type` chosen without reading codebase (guessing is forbidden)
- `evidence_type` outside the controlled vocabulary
- `check_command` that doesn't exist or has no exit-code contract
- `mode::afk` for cross-context or mid-flight product decisions
- Paste full requirement into issue — summarize + link source
- Use "no PRD" to skip this workflow entirely
- Leave `Requirement Source:` blank (Direct Mode) or `PRD:` placeholder (PRD Mode)
- `Shallow Module` beyond single-entity CRUD