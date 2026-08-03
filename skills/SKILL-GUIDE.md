# SKILL Authoring Guide

Reference: [agentskills.io/specification](https://agentskills.io/specification)

A good skill is **focused, verifiable, and self-contained**.

---

## Directory structure

```
skill-name/
├── SKILL.md          # Required: YAML frontmatter + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: REFERENCE.md, FORMS.md, domain docs
├── assets/           # Optional: templates, images, data files
└── ...
```

- `name` must match parent directory (lowercase, `a-z/0-9/-` only)
- Keep `SKILL.md` under 500 lines / ~5000 tokens
- Load reference files on demand; avoid deep nesting

---

## Frontmatter

```yaml
---
name: skill-name                    # lowercase, 1-64ch, a-z/0-9/- only
description: >-                     # 1-1024ch, what + when to use
  One sentence describing what the skill does
  and when to invoke it.
license: MIT                        # optional
compatibility: Requires git, glab   # optional, 1-500ch
metadata:                           # optional, arbitrary kv
  author: example-org
  version: "1.0"
---
```

**Rules:**
- `name` must match directory name exactly
- `description` should include trigger keywords for agent matching
- Progressive loading: metadata (~100 token) → body on activation → files on demand

---

## Body Structure

```
# <Skill Name>

**Goal:** one sentence — input → output contract.

## When to use

Precise trigger conditions. "When X, not when Y."

## Steps

Numbered, imperative. Each step has a clear precondition and output.

## Anti-patterns

Concrete failure modes — specific, not vague.
```

---

## Writing for Efficiency

**Trust model priors.** Don't explain what the model already knows.
Write "Reverse the array" not "Use a for loop to iterate backwards."

**Fewer steps = fewer failure points.** Every step is a failure opportunity.
Combine atomic actions into a single step.

**Parallel by default.** If two concerns don't share state, they can run
concurrently. Explicitly mark sequential dependency only when required.

**Explicit output location.** Always state where output goes — `/tmp/` for
transient, `skills/my-skill/` for durable. Ambiguity causes errors.

---

## Writing for Error Resistance

**Fail-closed on unclear state.** If a precondition isn't met, stop.
Don't guess or assume.

**Never skip gates.** Human confirmation points exist for a reason.
Removing them creates silent failures.

**No ambiguous language.** Avoid "consider", "maybe", "if appropriate",
"as needed". Either the step is required or it isn't.

**Concrete anti-patterns.** "MUST NOT write to repo" is actionable.
"Be careful with file writes" is useless.

---

## Quality Checklist

- [ ] `name` matches directory, lowercase, no consecutive hyphens
- [ ] `description` ≤ 1024 characters, includes trigger keywords
- [ ] Each step has clear precondition and output
- [ ] Anti-patterns are concrete (specific failure, not "be careful")
- [ ] No example code or command snippets
- [ ] `SKILL.md` under 500 lines
- [ ] Single responsibility — one skill does one thing

---

## Common Mistakes

### Scope creep

```markdown
# Bad — tries to be everything
# Implement, test, and deploy a feature

# Good — bounded
# Extract and summarize content from PDFs.
```

---

## Validation

```bash
skills-ref validate ./my-skill   # frontmatter + naming conventions
```
