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
