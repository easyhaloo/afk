# PRD Template

> The authoritative structure for AFK PRDs.
> Audience: LLM agents synthesizing PRDs, NOT human readers.
>
> Optimize for: stable token structure, parseable fields, behavior that
> downstream issue creators can directly slice into machine-checkable AC.

## When to Use

When synthesizing any alignment record into a PRD for publication. The
input format is the caller's choice — accept whatever was produced
upstream.

## Structure

```markdown
# PRD: <Short title>

## Problem Statement

<one paragraph: user-visible problem, who is affected, why now>

## Users & Jobs

- **User: <role>** — <job-to-be-done>
- **User: <role>** — <job-to-be-done>

## Bounded Contexts

- **<context name>** — <one-line responsibility>
- **<context name>** — <one-line responsibility>

## User Stories

Each story maps to one bounded context and produces one issue downstream.

### Story: <verb> <object>

- **As a** <role>
- **I want** <capability>
- **So that** <outcome>

**Observable Behavior:**
- <user-visible behavior that can be observed from outside the system>
- <boundary condition, edge case, error path>

**Out of Scope** (this story):
- <item>
- <item>

### Story: <verb> <object>

...

## Key Decisions

Each decision is **already made** in upstream context or spike.
Format per decision:

- **Decision:** <what was decided>
- **Rationale:** <why>
- **Reversible:** yes | no
- **ADR:** ADR-NNNN (or "none — needs ADR" if irreversible and unrecorded)

## Open Risks

Each risk is **unresolved** — needs future decision or monitoring.

- **Risk:** <what could go wrong>
- **Impact:** <high | medium | low>
- **Mitigation:** <plan or "TBD">

## Non-Goals

- <what this PRD will NOT do>
- <what this PRD will NOT do>

```

## Field Reference

| Field | Required | Format | Purpose |
|-------|----------|--------|---------|
| `# PRD: <title>` | yes | one line | Document name |
| `## Problem Statement` | yes | one paragraph | Why this work |
| `## Users & Jobs` | yes | bulleted list | Audience |
| `## Bounded Contexts` | yes | bulleted list | Slicing boundaries |
| `## User Stories` | yes | ≥1 story block | What gets built |
| `## Key Decisions` | yes | bulleted list | Decided things |
| `## Open Risks` | yes | bulleted list | Undecided things |
| `## Non-Goals` | yes | bulleted list | Explicit exclusions |

## User Story Format

Each story block:

```
### Story: <verb> <object>

- **As a** <role>
- **I want** <capability>
- **So that** <outcome>

**Observable Behavior:**
- <user-visible behavior observable from outside the system>
- <boundary condition>

**Out of Scope** (this story):
- <item>
```

### Observable Behavior — what to write

Each behavior must be:
- **User-observable** — visible from outside the system (HTTP response, UI state, log line, file content, CLI output). Not "code is clean" or "module structure is right".
- **Bounded** — single concrete outcome, not "and also...".
- **Falsifiable** — someone can point at shipped behavior and say yes/no.

Do not write test commands or evidence types here — those belong to the
issue template, generated downstream by reading the codebase.

## Story Granularity

- **Too coarse:** story has > 4 Observable Behaviors or touches > 1 bounded context → split
- **Too fine:** story has 0 Observable Behaviors or no user-observable behavior → fold
- **Default:** one context per story, 2-4 Observable Behaviors per story

## Anti-Patterns

- Observable Behaviors that are implementation details ("uses Redis", "calls `validateToken()`")
- Stories that mix multiple bounded contexts (slicing target unclear)
- Key Decisions that are actually open risks (undecided masquerading as decided)
- Open Risks that are actually decided (decided masquerading as open)
- "We can fix it later" as a Key Decision rationale