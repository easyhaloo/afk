---
name: afk-to-prd
disable-model-invocation: true
description: >-
  Synthesize aligned requirements into a provider-neutral PRD for publication
  and later external backlog decomposition. Produces problem, users, bounded
  contexts, user stories, decisions, risks, and non-goals without creating
  provider records or invoking AFK execution commands.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# PRD

**Goal:** Synthesize an alignment record into a PRD artifact that an external
backlog/decomposition system can consume. Synthesis, not discovery.
**Mode:** HITL-gated — drafting is agent-driven; publication requires explicit
approval.
**Contract:** sufficient alignment input → approved `PRD.md` artifact. The
artifact is handed to the external backlog provider; it is not published as
an issue and does not carry provider labels.

## Preconditions

The caller has assembled an **alignment record** containing at minimum:

- The problem being solved and who is affected
- Scope (in / out)
- Decisions already made and open questions

Accept any upstream format. If required content is missing, ask for
clarification; do not invent it.

## Handling incomplete or conflicting input

This phase exposes gaps rather than resolving them:

- Carry unresolved questions into **Open Risks** verbatim.
- Record contradictions as a Key Decision with both positions and the
  resolution rationale; do not silently overwrite the older statement.
- If revising a PRD after a backlog manifest exists, update the PRD in place
  and identify every downstream item affected so the external provider can
  re-synchronize it.

## End state

This skill ends after the caller approves the PRD draft and the approved file
is written to the requested artifact location (for example
`/tmp/PRD-<slug>.md`). No task decomposition, backlog creation, branch
creation, agent execution, QA, or provider metadata updates are authorized.
The caller explicitly invokes the external decomposition/provider workflow or
the AFK execution commands separately.

## Steps

### Step 1 — Verify alignment against code (when applicable)

Read the alignment record. Optionally inspect existing code to verify bounded
contexts and architecture decisions:

- If modules/packages are named, verify they exist and imports match.
- If an architecture is described, verify the module graph.
- Flag mismatches as Open Risks; do not silently correct the input.

### Step 2 — Draft PRD to a temporary file

Always read `references/prd-template.md` before drafting. Include:

- Problem Statement
- Users & Jobs
- Bounded Contexts
- User Stories with Observable Behaviors
- Key Decisions
- Open Risks
- Non-Goals

Observable Behaviors must be user-visible, bounded, and falsifiable. Do not
put test commands or evidence types in the PRD; those are added when the
external backlog system decomposes stories into executable items.

For each significant technical choice, check whether an ADR is warranted.
If it is irreversible and expensive to change, create or reference a proposed
ADR in `docs/adr/ADR-NNNN.md` according to `references/adr-process.md`.

Draft to `/tmp/PRD-<slug>.md` (or the caller's requested path). Do not publish
or hand off until approval.

### Step 3 — HITL approval gate

Ask the caller to choose one outcome:

- **Approve** — write the approved PRD artifact and end.
- **Revise** — incorporate specific feedback, then return to Step 2.
- **Drill deeper** — re-check alignment or architecture, then re-draft.
- **Add open question** — add the gap to Open Risks and return to this gate.

Do not perform any external mutation before an explicit approval.

## Caveats

- Do not invent user stories absent from the alignment record; record gaps as
  Open Risks.
- Do not skip approval.
- Keep decided items under Key Decisions and undecided items under Open Risks.
- Do not include provider-specific labels, numeric issue IDs, branch names, or
  execution state in the PRD.
- Do not invoke `afk backlog`, `afk run`, `afk loop`, or `afk qa` from this
  synthesis skill; those commands operate on already-created backlog items.

## References

| File | Read when |
|---|---|
| `references/prd-template.md` | **Always** — defines the PRD schema |
| `references/adr-process.md` | When a significant technical choice may need an ADR |
