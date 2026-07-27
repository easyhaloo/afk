---
name: afk-to-issues
description: >-
  Decompose requirements into GitLab issues with machine-checkable AC.
  PRD Mode (full fidelity) or Direct Mode (any requirement context).
disallowed-tools: >-
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# Requirements -> Issues

**Goal:** Independently pickable GitLab issues with verifiable completion conditions.
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
| PRD Mode | `PRD.md` + `## Bounded Contexts` | Full fidelity |
| Direct Mode | Any requirement context | Always available — MUST NOT skip |

## Bounded Context Inference (Direct Mode)

1. Identify distinct domain areas and independently-changeable concerns
2. Group related changes under one context; unclear → use `core`, `api`, `ui`
3. Single-issue contexts may merge into adjacent ones

## Slicing Rules (both strategies)

- **Too big:** AC > ~5 lines, or touches > ~3 modules → split
- **Too small:** no user-observable behavior → fold into caller or mark tech-debt
- **Cycle check:** trace `blocked_by` graph; redraw boundaries if cyclic
- **Direct Mode:** ask user to narrow if requirement too large

## Issue Template

```markdown
## Context
<one-sentence summary of what this covers>

PRD: <link>                                   <!-- PRD-only -->
Requirement Source: <source>                   <!-- Direct Mode -->

## Bounded Context
<context name — explicit or inferred>

## Relevant ADRs
- ADR-NNNN: <title> — <why ADR constrains this>
(none if no ADR applies)

## Module Mode
Deep Module  <!-- or Shallow Module (CRUD only) -->

## Acceptance Criteria
- [ ] <observable outcome>
  _verify: <cmd: | api: | ui:>_
- [ ] ...

## Non-goals
<what this will NOT do>

## Mode
mode::afk   <!-- or mode::hitl -->
```

## Steps

1. **Path:** PRD + `## Bounded Contexts` → PRD Mode; else → Direct Mode
2. **Gather:** Read PRD or requirement context; ask user to narrow if too vague
3. **Infer & slice:** Analyze requirement → auto-select best-fit strategy → slice. Only ask user to choose if both Vertical and Horizontal are equally viable.
4. **Quality gate:** every AC needs `_verify:` suffix
5. **Create:**
   - PRD Mode: `base::prd-<iid>`
   - Direct Mode: `base::direct`
   - Both: `stage::ready-for-issues,<mode>`
   - DAG via `afk gitlab link-issues <source-iid> <target-iid>`
6. **HITL gate:** show issue list + DAG; get approval before creating any

## Anti-patterns

- AC without `_verify:` suffix
- `mode::afk` for cross-context or mid-flight product decisions
- Paste full requirement into issue — summarize + link source
- Use "no PRD" to skip this workflow entirely
- Leave `Requirement Source:` blank (Direct Mode) or `PRD:` placeholder (PRD Mode)
- `Shallow Module` beyond single-entity CRUD
