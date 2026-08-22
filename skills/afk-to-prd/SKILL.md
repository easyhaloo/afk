---
name: afk-to-prd
disable-model-invocation: true
description: >-
  Synthesize aligned requirements into a PRD and, after approval, create its
  root AFK backlog record. Produces problem, users, bounded contexts, user
  stories, decisions, risks, non-goals, and the canonical backlog ID and URL.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# PRD

**Goal:** Synthesize an alignment record into an approved PRD artifact and
create its root AFK backlog record. Synthesis, not discovery.
**Mode:** HITL-gated — drafting is agent-driven; publication requires explicit
approval.
**Contract:** sufficient alignment input → approved `PRD.md` artifact → root
backlog created by `afk backlog create`. The returned canonical backlog ID and
URL are the parent reference for downstream `/afk-to-issues` work.

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
- If revising a PRD after child backlogs exist, update the PRD in place and
  identify every downstream item affected. Do not create duplicate roots.

## End state

This skill ends after the caller approves the PRD draft, the approved file is
written to the requested artifact location (for example `/tmp/PRD-<slug>.md`),
and AFK creates the root backlog. Return and record both its canonical ID and
concrete URL. No task decomposition, branch creation, agent execution, or QA
is authorized.

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
put test commands or evidence types in the PRD; those are added when
`/afk-to-issues` decomposes stories into executable child backlogs.

For each significant technical choice, check whether an ADR is warranted.
If it is irreversible and expensive to change, create or reference a proposed
ADR in `docs/adr/ADR-NNNN.md` according to `references/adr-process.md`.

Draft to `/tmp/PRD-<slug>.md` (or the caller's requested path). Do not publish
or hand off until approval.

### Step 3 — HITL approval and root backlog creation

Ask the caller to choose one outcome:

- **Approve** — write the approved PRD artifact, then create its root backlog.
- **Revise** — incorporate specific feedback, then return to Step 2.
- **Drill deeper** — re-check alignment or architecture, then re-draft.
- **Add open question** — add the gap to Open Risks and return to this gate.

Do not perform any external mutation before an explicit approval. After
approval, invoke AFK only, never a provider API or `gh`/`glab` command:

```bash
afk backlog create "PRD: <short title>" \
  --description-file /tmp/PRD-<slug>.md \
  --mode hitl \
  --tag prd
```

Read the command output and record both `Created backlog <id>` and `url:`.
Return them to the caller as `rootBacklogId` and `rootBacklogUrl`. The root is
organizational and remains `hitl`; `/afk-to-issues` creates its executable
children with `--parent <rootBacklogId>`. Never parse or invent a provider
URL: use the concrete URL returned by AFK.

## Caveats

- Do not invent user stories absent from the alignment record; record gaps as
  Open Risks.
- Do not skip approval.
- Keep decided items under Key Decisions and undecided items under Open Risks.
- Do not include provider-specific labels, numeric issue IDs, branch names, or
  execution state in the PRD body. The AFK CLI adds its own metadata.
- Do not invoke `afk run`, `afk loop`, or `afk qa` from this synthesis skill.
- Never create the root before approval or call provider APIs directly.

## References

| File | Read when |
|---|---|
| `references/prd-template.md` | **Always** — defines the PRD schema |
| `references/adr-process.md` | When a significant technical choice may need an ADR |
