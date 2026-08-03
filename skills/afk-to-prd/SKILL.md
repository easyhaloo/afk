---
name: afk-to-prd
disable-model-invocation: true
description: >-
  Use when any structured requirements input is ready to be synthesized
  into a PRD for publication. Produces a structured PRD with
  problem, users, bounded contexts, user stories, decisions, and risks.
  Does not depend on any other skill — accepts any input that contains
  sufficient alignment (interview notes, design drafts, requirement
  documents, or referenced sibling artifacts).
disallowed-tools: >-
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(gh issue delete*) Bash(gh repo delete*)
  Bash(git push -f) Bash(git reset --hard*) Bash(git branch -D*)
---

# PRD

**Goal:** synthesize an alignment record into a PRD for publication.
Synthesis, not discovery.
**Mode:** HITL-gated — drafting is agent-driven; publication requires
explicit approval.
**Contract:** sufficient alignment input → approved `PRD.md` + `stage::prd`.

## Preconditions

The caller has assembled an **alignment record** that contains at minimum:

- The problem being solved and who is affected
- The scope (in / out)
- Any decisions already made and any open questions

The format of the alignment record is the caller's choice — accept
whatever was produced upstream. If the record is missing required
content, ASK the caller for clarification; do not invent.

## Handling incomplete or conflicting input

Synthesis assumes clean input. Real input rarely is. This phase has no
mandate to resolve gaps or conflicts — only to make them visible:

- **Unresolved open questions in the input:** carry into PRD's Open
  Risks verbatim. MUST NOT quietly resolve them — synthesis is not
  license to make the product decision left open.
- **Input contains contradictions:** record as a Key Decision with both
  positions and resolution rationale. MUST NOT silently overwrite the
  older statement.
- **Revising a published PRD after issues exist downstream:** update
  `PRD.md` in place, comment on every affected issue with a link to
  what changed. MUST NOT let issues silently drift out of sync.

## End State

This skill terminates after the caller approves the PRD draft and it is
published as an issue with `stage::prd` label. No further agent actions
are authorized — no task lists, no branch creation, no decomposition,
no planning. The caller must explicitly invoke another skill or issue a
new command for any follow-on work.

## Steps

### Step 1 — Verify alignment against code (when applicable)

Read the alignment record. **Then optionally read existing code** to
verify bounded contexts and architecture decisions are accurate:

- If the record describes specific modules/packages → verify they exist
  and imports match described boundaries
- If the record describes an architecture → verify actual module graph
  matches
- If mismatch found → flag as Open Risk in PRD. Do NOT silently correct.

This code check is verification, not research — it confirms or
questions what the alignment record already states.

### Step 2 — Draft PRD to `/tmp/`

Use the authoritative template at **`references/prd-template.md`** —
read it before drafting. Highlights:

- Sections: Problem Statement, Users & Jobs, Bounded Contexts, User
  Stories, Key Decisions, Open Risks, Non-Goals.
- Each User Story's AC uses the **3-field `--` format**: `<text> --
  <evidence_type> -- <check_command>`.
- `evidence_type` ∈ {test, curl, log, manual, none} — controlled
  vocabulary; do not invent new values.
- Key Decisions = already-decided. Open Risks = undecided. Do not mix.

**ADR trigger:** for each significant technical choice, check whether
to create an ADR. If irreversible and expensive to change → create an
ADR in `docs/adr/ADR-NNNN.md` (status: proposed) and reference it in the
PRD.

Draft to `/tmp/PRD-<slug>.md` — this is a temporary file. Use Bash
(`cat > /tmp/... << 'EOF'` or `tee`) to write. **Do not use the Write
tool** — it requires reading the file first even for new paths. Do NOT
publish until Step 3 approval.

### Step 3 — Gate (AskQuestion)

Use `AskQuestion` with single-select to collect the caller's decision:

- **Approve** → publish PRD as issue (`afk issue create ... --label stage::prd`), write approved PRD to `/tmp/PRD-<slug>.md` using Bash → **END**
- **Revise** → return to Step 2 with specific feedback
- **Drill deeper** → return to Step 1 (verify) or Step 2 (re-draft)
- **Add open question** → record gap in Open Risks, return to Step 3 Gate for re-confirmation

Do NOT proceed to any action until one option is selected.

## Caveats

- MUST NOT invent user stories absent from the alignment record — flag
  gaps as Open Risks.
- MUST NOT skip the approval gate — decomposing into issues is the
  expensive step this gate protects.
- MUST NOT use a free-form AC schema — every AC must have the 3-field
  `--` separator with a controlled `evidence_type`.
- MUST NOT put undecided things under Key Decisions, or decided things
  under Open Risks.
- MUST NOT use the Write tool for `/tmp/` output — use Bash (`cat >`, `tee`, or similar) instead. The Write tool requires a prior Read even for new file paths.

## References

| File | Read when |
|------|-----------|
| `references/prd-template.md` | **Always** — defines the PRD schema you emit |