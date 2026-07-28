# PRD Template

> The authoritative structure for AFK PRDs.
> Audience: LLM agents synthesizing PRDs, NOT human readers.
> Downstream consumer: `afk-to-issues` slices PRD into issues.
>
> Optimize for: stable token structure, parseable fields, AC that
> downstream can directly lift into issue template without rewrite.

## When to Use

When synthesizing approved `CONTEXT.md` (from `afk-grill-me`) plus
optional spike findings into a PRD for publication.

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

**Acceptance Criteria** (3-field format — same as issue template):

- [ ] <text> -- <evidence_type> -- <check_command>
- [ ] <text> -- <evidence_type> -- <check_command>

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

## Mode

`mode::afk`   <!-- or mode::hitl -->
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
| `## Mode` | yes | one token | Autonomous or human |

## User Story Format

Each story block:

```
### Story: <verb> <object>

- **As a** <role>
- **I want** <capability>
- **So that** <outcome>

**Acceptance Criteria** (3-field format):
- [ ] <text> -- <evidence_type> -- <check_command>

**Out of Scope** (this story):
- <item>
```

### Acceptance Criteria — same schema as issue template

Use the **identical 3-field `--` format** documented at the downstream
consumer. Field semantics:

| Field | Controlled vocabulary |
|-------|----------------------|
| `evidence_type` | `test` \| `curl` \| `log` \| `manual` \| `none` |
| `check_command` | shell command, exit 0 = PASS |

The downstream `afk-to-issues` slices each story's AC list directly
into the issue's AC field — keep format identical, no rewriting.

## Story Granularity

- **Too coarse:** story has > 5 AC items or touches > 3 contexts → split
- **Too fine:** story has 0 AC items or no user-observable behavior → fold
- **Default:** one context per story, 2-4 AC items per story

## Anti-Patterns

- AC items without `-- <type> -- <command>` (downstream can't parse)
- `evidence_type` outside the controlled vocabulary
- Stories that mix multiple bounded contexts (slicing target unclear)
- Key Decisions that are actually open risks (undecided masquerading as decided)
- Open Risks that are actually decided (decided masquerading as open)
- Mode other than `mode::afk` or `mode::hitl`
- "We can fix it later" as a Key Decision rationale