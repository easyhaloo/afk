# SKILL Authoring Guide

Reference: [agentskills.io/specification](https://agentskills.io/specification)

A good skill is **focused, verifiable, and tool-agnostic**.

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
name: afk-<noun>                    # lowercase, 1-64ch, a-z/0-9/- only
description: >-                     # 1-1024ch, what + when to use
  One sentence: when to invoke, what it produces.
  Include mode hint: HITL / AFK / Auto.
license: MIT                        # optional
compatibility: Requires git, glab   # optional, 1-500ch
metadata:                           # optional, arbitrary kv
  author: example-org
  version: "1.0"
disallowed-tools: >-               # AFK extension: denylist
  Edit(*) Write(*)
  Bash(git push*) Bash(rm -rf*)
---
```

**Rules:**
- `name` must match directory name exactly
- `description` should include trigger keywords for agent matching
- `disallowed-tools` is an AFK-specific denylist; use `Tool(pattern)` syntax
- Progressive loading: metadata (~100 token) → body on activation → files on demand

---

## Body Structure

```
# <Skill Name>

**Goal:** one sentence — input → output contract.
**Mode:** HITL | AFK | Auto
**Contract:** explicit termination condition.

## When to use

Table or bullet — precise trigger conditions. "When X, not when Y."

## Steps

Numbered, imperative. Each step:
- Has a clear precondition
- States what it produces
- Has a fail-closed gate if destructive

## Anti-patterns

"MUST NOT" bullets — concrete failure modes, not vague warnings.
```

---

## AFK-Specific Constraints

| Rule | Reason |
|------|--------|
| No tool names in body | Agents / Tasks / Bash are primitives; describe intent |
| No example code blocks | Code dates; intent is stable |
| Prefer nouns over verbs | "Fan out independent paths" not "Use Agent to fan out" |
| Bounded scope | One skill, one mode, one exit condition |
| HITL gates for destructive steps | Never auto-delete, auto-merge, auto-push |
| Output path explicit | `/tmp/` for transient, repo for durable |
| `disallowed-tools` uses `Tool(pattern)` | Subcommand glob, not blanket block |

---

## Quality Checklist

- [ ] `name` matches directory, lowercase, no consecutive hyphens
- [ ] `description` ≤ 1024 characters, includes mode hint and trigger keywords
- [ ] `disallowed-tools` uses `Tool(subpattern)` syntax
- [ ] No tool names appear in body text
- [ ] Each step has clear precondition and output
- [ ] Anti-patterns are concrete (specific failure, not "be careful")
- [ ] Output location specified (`/tmp/` vs repo)
- [ ] Termination condition is explicit
- [ ] No example code or command snippets
- [ ] `SKILL.md` under 500 lines
- [ ] Single responsibility — one skill does one thing

---

## Common Mistakes

### Over-restrictive denylist

```yaml
# Bad — blocks too much
disallowed-tools: Bash(*) Agent(*) Task(*)
```

```yaml
# Good — only dangerous subcommands blocked
disallowed-tools: Bash(git push*) Bash(git reset --hard*)
```

### Tool names in body

```markdown
# Bad
Use the Agent tool to fan out parallel work.

# Good
Fan out independent paths to parallel workers.
```

### Scope creep

```markdown
# Bad — tries to be everything
# Implement, test, and deploy a feature

# Good — bounded
# Implement a tracker issue to MR, with QA gate.
```

---

## Validation

```bash
skills-ref validate ./my-skill   # frontmatter + naming conventions
```
