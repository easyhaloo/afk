---
name: afk-to-prd
description: >-
  Use when approved context doc is ready to be synthesized into a PRD
  for publication to GitLab. Produces structured PRD with user stories,
  scope, key decisions, and open risks.
disallowed-tools: >-
  Bash(glab mr merge*) Bash(glab mr delete*) Bash(glab repo delete*)
  Bash(git push -f) Bash(git reset --hard*) Bash(git branch -D*)
---

# PRD

**Goal:** synthesize upstream alignment record plus any spike learnings
into a PRD for publication to GitLab. Synthesis, not discovery.
**Mode:** HITL-gated — drafting is agent-driven; publication requires
explicit approval.
**Contract:** approved `CONTEXT.md` (+ optional spike findings) →
approved `PRD.md` + `stage::prd`.

## Preconditions

An approved `CONTEXT.md` exists. Spike findings are optional. Missing:
STOP. MUST NOT re-interview if that alignment record is already solid.

## Handling incomplete or conflicting input

Synthesis assumes clean input. Real input rarely is. This phase has no
mandate to resolve gaps or conflicts — only to make them visible:

- **Unresolved Open Questions in `CONTEXT.md`:** carry into PRD's Open
  Risks verbatim. MUST NOT quietly resolve them — synthesis is not
  license to make the product decision left open.
- **Spike findings contradict CONTEXT.md assumption:** record as a Key
  Decision with both positions and resolution rationale. MUST NOT
  silently overwrite the older assumption.
- **Revising a published PRD after issues exist downstream:** update
  `PRD.md` in place, comment on every affected issue with a link to
  what changed. MUST NOT let issues silently drift out of sync.

## Steps

### Step 1 — Verify context against code

Read `CONTEXT.md` and any spike notes. **Then optionally read existing
code** to verify bounded contexts and architecture decisions are accurate:

- If CONTEXT.md describes specific modules/packages → verify they exist
  and imports match described boundaries
- If CONTEXT.md describes an architecture → verify actual module graph matches
- If mismatch found → flag as Open Risk in PRD. Do NOT silently correct.

This code check is verification, not research — it confirms or questions
what CONTEXT.md already states.

### Step 2 — Write `PRD.md`

Use the authoritative template at **`references/prd-template.md`** — read
it before drafting. Highlights:

- Sections: Problem Statement, Users & Jobs, Bounded Contexts, User Stories,
  Key Decisions, Open Risks, Non-Goals, Mode.
- Each User Story's AC uses the **3-field `--` format** identical to the
  downstream issue template (`<text> -- <type> -- <command>`).
- Key Decisions = already-decided. Open Risks = undecided. Do not mix.

**ADR trigger:** for each significant technical choice, check whether
to create an ADR. If irreversible and expensive to change → create an
ADR in `docs/adr/ADR-NNNN.md` (status: proposed) and reference it in
the PRD.

### Step 3 — Publish

Existing tracking Epic/Issue → link `PRD.md` via
`afk gitlab add-comment <iid> "$(cat PRD.md)"`. None exists →
`afk gitlab issue-create "<title>" --description "$(cat PRD.md)" --label stage::prd`.

### Step 4 — Label

New issue already got `stage::prd` via step 3. Existing issue needs:
`afk gitlab issue-update <iid> --add-label stage::prd`.

### Step 5 — Gate (HITL)

Explicit user approval required before this PRD is decomposed into
issues. One-line summary + link, not full PRD pasted into chat.

## Anti-patterns

- MUST NOT invent user stories absent from the alignment record — flag
  gaps as Open Risks.
- MUST NOT skip the approval gate — decomposing into issues is the
  expensive step this gate protects.
- MUST NOT use a different AC schema than the downstream issue template —
  `afk-to-issues` slices PRD AC directly into issues.
- MUST NOT put undecided things under Key Decisions, or decided things
  under Open Risks.

## References

| File | Read when |
|------|-----------|
| `references/prd-template.md` | **Always** — defines the PRD schema you emit |
