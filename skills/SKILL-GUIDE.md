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

## Steps

Numbered, imperative. Steps reflect actual workflow shape — not every
step needs explicit Precondition/Output labeling.

## Caveats

Concrete failure modes — specific, not vague.
```

**On steps:** Precondition/Output labeling is appropriate when steps have
complex dependencies. For linear or obvious flows, a brief imperative
description suffices. Do not add labels as formulaic decoration.

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

### LLM-first design

Skill content is consumed by an LLM, not a human. Write for model
parsing: concise keywords, structured sections, no prose walls.
The LLM should be able to extract the skill's intent and steps
without deciphering verbose explanations.

### Concise description

Frontmatter `description` is the **only trigger carrier**. It is loaded
at startup for skill matching. Body is only loaded after activation.
One to two sentences: what it does and when to invoke it. Use binary
judgment — "does X, not Y" — not scoring scales, fuzzy qualifiers, or
self-referential statements. Never duplicate trigger logic in body.

### Body minimization

Describe the full flow in SKILL.md. If detailed content is needed,
navigate to `references/`, `templates/`, `assets/`, or `scripts/`.
SKILL.md is the index; detail lives in linked files.

### Abstraction over explanation

Prefer concise keywords that trigger LLM priors. Write "fan out parallel
paths" not "launch multiple subagents to concurrently process independent
tasks." The model fills in the rest. Redundant explanation dilutes signal.

**Knowledge determination — what the LLM actually knows:**

LLM knowledge comes from: (1) training data, (2) current context (loaded skill files).

```
判定公式:
  训练数据中有 → 抽象 (LLM 知道)
  只有 skill 文件中有 → 保留 (LLM 只因上下文而知道)

问自己: 这个术语在 skill 文件之外还存在吗?
  - 存在于通用知识/主流工具 → 抽象
  - 只存在于本项目 skill 文件中 → 保留
```

**Decision table:**

| Type | Action | Example |
|------|--------|---------|
| Training data has it | Abstract | `git commit`, `jest`, `for loop` |
| Only in skill file | PRESERVE | `mode::afk`, `base::prd-<iid>`, `afk issue create --label` |

**Critical:** When in doubt, keep the concrete value. "mode label" is
ambiguous; `mode::afk` is precise. Over-abstraction causes execution
errors; over-specification only adds verbosity.

### Domain knowledge separation

If a skill requires specialized knowledge the LLM doesn't have (e.g.,
finance术语, regulatory rules, proprietary patterns), document it in a
dedicated reference file. Don't bury domain context in SKILL.md.

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

### Self-contained

A skill must be self-contained. It must not read files outside its own
directory tree. External knowledge must be inlined or copied into
`references/` within the skill's own directory. Directory boundary is
absolute — no out-of-bounds reads under any circumstance.

---

## Quality Checklist

- [ ] `name` matches directory, lowercase, no consecutive hyphens
- [ ] `description` ≤ 1024 characters, includes trigger keywords
- [ ] Steps reflect actual workflow shape; no formulaic decoration
- [ ] Caveats are concrete (specific failure, not "be careful")
- [ ] No example code or command snippets
- [ ] `SKILL.md` under 500 lines
- [ ] Single responsibility — one skill does one thing
- [ ] Domain-specific terms and values preserved (not abstracted away)

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
