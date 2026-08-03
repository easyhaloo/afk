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

## Caveats

Concrete failure modes — specific, not vague.
```

---

## Efficiency Patterns

Reusable patterns for writing efficient, high-throughput skills.

### Fan out for parallel paths

When multiple independent research or analysis paths exist, send them to
parallel workers. Each worker gets one path and returns a focused summary.

- Multiple code areas to survey
- Multi-source cross-validation
- Independent features in the same deliverable

### Sequential when results narrow scope

When one step's output determines what the next step should investigate,
run sequentially. Parallel would waste workers on irrelevant paths.

### Fewer steps, fewer failures

Every step is a failure point. Combine atomic actions into a single step
when they have no meaningful checkpoint between them.

### Trust model priors

Don't explain what the model already knows. Write "Reverse the array"
not "Use a for loop to iterate backwards."

---

## Constraint Rules

Negative patterns — things a skill should never do.

### Fail-closed on unclear state

If a precondition isn't met, stop. Don't guess, assume, or continue.
A skill that fails loudly is better than one that fails silently.

### No ambiguous language

Avoid "consider", "maybe", "if appropriate", "as needed". Either the
step is required or it isn't. Ambiguity causes execution drift.

### Explicit output location

Always state where output goes. `/tmp/` for transient drafts, skill
directory for durable artifacts. Ambiguity causes file system errors.

### No example code or commands

Code and commands date quickly. Describe intent and outcome instead.
The model knows the syntax; show it what to do, not how to do it.

---

## Quality Checklist

- [ ] `name` matches directory, lowercase, no consecutive hyphens
- [ ] `description` ≤ 1024 characters, includes trigger keywords
- [ ] Each step has clear precondition and output
- [ ] Caveats are concrete (specific failure, not "be careful")
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

## Extending This Guide

Add new efficiency patterns under **Efficiency Patterns** with:
- Pattern name
- When to apply (trigger conditions)
- When NOT to apply (anti-patterns)

Add new constraint rules under **Constraint Rules** with:
- Rule name
- Concrete caveat scenario
- Why it causes errors

---

## Validation

```bash
skills-ref validate ./my-skill   # frontmatter + naming conventions
```
