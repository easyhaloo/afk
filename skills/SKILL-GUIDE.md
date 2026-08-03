# SKILL Authoring Guide

Standards for writing `SKILL.md` files. A good skill is **focused,
verifiable, and tool-agnostic**.

---

## Frontmatter

```yaml
---
name: afk-<noun>
description: >-
  One sentence: when to invoke, what it produces.
  Include "mode" hint: HITL / AFK / Auto.
disable-model-invocation: true   # true = LLM reasoning only, no subagents
disallowed-tools: >-
  Edit(*) Write(*)               # never bare names; always Tool(pattern)
  Bash(git push*) Bash(rm -rf*) # specific dangerous patterns only
---
```

**Rules:**
- `disallowed-tools` is **denylist only** — do not list allowed tools
- Each entry: `Tool(subpattern)` — subpattern supports glob `*`
- Prefer specific subpatterns over broad tool blocks (`Bash(git push*)` not `Bash(*)`)
- `disable-model-invocation: true` for pure reasoning / interview / routing skills

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

## Style Constraints

| Rule | Reason |
|------|--------|
| No tool names in body | Agents / Tasks / Bash are primitives; body describes intent |
| No example code blocks | Code dates; intent is stable |
| Prefer nouns over verbs | "Fan out independent paths" not "Use Agent to fan out" |
| Bounded scope | One skill, one mode, one exit condition |
| HITL gates for destructive steps | Never auto-delete, auto-merge, auto-push |
| Output path explicit | `/tmp/` for transient, repo for durable |
| No Swiss-army skills | If it needs sub-skills, it needs its own pipeline |

---

## Quality Checklist

- [ ] Description includes mode (HITL / AFK / Auto)
- [ ] `disallowed-tools` uses `Tool(pattern)` syntax
- [ ] No tool names appear in body text
- [ ] Each step has a clear precondition and output
- [ ] Anti-patterns are concrete (specific failure, not "be careful")
- [ ] Output location specified (`/tmp/` vs repo)
- [ ] Termination condition is explicit
- [ ] No example code or command snippets
- [ ] Single responsibility — one skill does one thing

---

## Common Mistakes

### Over-restrictive disallowed-tools

```yaml
# Bad — blocks too much, makes skill unusable
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
```

```markdown
# Good — bounded
# Implement a tracker issue to MR, with QA gate.
```

---

## Anti-patterns (Examples)

- **MUST NOT write output to repo** — only `/tmp/` for transient drafts
- **MUST NOT skip the human gate** — destructive actions always need confirmation
- **MUST NOT use the same source for verification as for assumption** — cross-validate
- **MUST NOT produce partial work** — if blocked, escalate to HITL
