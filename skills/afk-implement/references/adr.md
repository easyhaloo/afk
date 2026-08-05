# ADR Recording in AFK Implement

**Purpose**: Capture architectural decisions discovered during implementation that were not anticipated in the PRD phase.
**When**: afk-implement execution — when a significant choice is made that isn't already documented in `docs/adr/`.
**Output**: New or updated ADR files in the project's `docs/adr/`.

---

## When to Write an ADR During Implementation

Implementation reveals decisions that weren't visible in the planning phase.

| Trigger | Example |
|---------|---------|
| Technology choice made at write-time | "We need a cache — use Redis or in-memory?" |
| Library choice | "PDF parsing — use library A or library B?" |
| Data model change | "Store attachments in object storage or database?" |
| API design decision | "Sync or async processing?" |
| Cross-cutting concern | "Where to put deduplication logic?" |

---

## ADR Creation Process

### Step 1 — Check Existing ADRs

Before making any new significant decision:

```bash
# Check if this is already covered
ls docs/adr/
cat docs/adr/ADR-*.md | grep -i "<keyword>"
```

### Step 2 — Write the ADR (status: proposed)

```bash
# Find next number
N=$(ls docs/adr/ADR-*.md 2>/dev/null | sed 's/.*ADR-0*\([0-9]*\).*/\1/' | sort -n | tail -1)
NEXT=$((N + 1))
FILENAME=$(printf "ADR-%04d-title-slug.md" $NEXT)
```

### Step 3 — Fill In

Use standard ADR template (see `docs/adr/ADR-template.md`):

```markdown
# ADR-NNNN: <Title>

**Date**: YYYY-MM-DD
**Status**: proposed
**Deciders**: AFK implementation

## Context
<Why is this decision necessary? What forces are at play?>

## Decision
<What we decided to do>

## Alternatives Considered
### Alternative 1: <Name>
- **Pros**:
- **Cons**:
- **Why not**:

## Consequences
### Positive
-
### Negative
-

## When to Reconsider
<Trigger conditions>
```

### Step 4 — Link in Commit

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat: <desc> (backlog {backlogId})

ADR: ADR-NNNN "<title>" created

Next: <concrete next action>
EOF
)"
```

---

## During auto_wrapup / AC Check

If the implementation revealed an architectural decision:
1. Note it in the commit message
2. Create the ADR file
3. Add `docs/adr/` update to the AC checklist evidence

---

## Anti-Patterns

- MUST NOT write an ADR for every small choice — reserve for significant decisions
- MUST NOT skip documenting the alternatives considered
- MUST NOT mark `accepted` until the implementation is complete
- MUST NOT write vague context like "we need a cache" — be specific
- MUST NOT create duplicate ADRs — check existing ones first
