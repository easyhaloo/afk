# SKILL-GUIDE Checklist

## Quality Checklist

- [ ] `name` matches directory, lowercase, no consecutive hyphens
- [ ] `description` ≤ 1024 characters, includes trigger keywords
- [ ] Each step has clear precondition and output
- [ ] Caveats are concrete (specific failure, not "be careful")
- [ ] No example code or command snippets
- [ ] `SKILL.md` under 500 lines
- [ ] Single responsibility — one skill does one thing

## Constraint Rules

- **LLM-first design**: concise keywords, structured sections, no prose walls
- **Concise description**: description is the **only trigger carrier** — startup loads it for matching, body loads only after activation. Binary judgment, "does X, not Y". Never duplicate trigger logic in body.
- **Body minimization**: detail in references/, SKILL.md is the index
- **Abstraction over explanation**: keyword-driven, trust model priors
- **Domain knowledge separation**: specialized knowledge in references/
- **Fail-closed on unclear state**: stop if precondition not met
- **No ambiguous language**: no "consider", "maybe", "if appropriate"
- **Explicit output location**: `/tmp/` for transient, skill dir for durable
- **No example code or commands**: intent over syntax
- **Self-contained**: directory boundary is absolute, no out-of-bounds reads

## Directory Structure

```
skill-name/
├── SKILL.md          # Required
├── scripts/          # Optional: executable code
├── references/       # Optional: REFERENCE.md, FORMS.md, domain docs
├── assets/           # Optional: templates, images, data files
└── ...
```

## Body Structure

```
**Goal:** input → output contract.

## Steps

Numbered, imperative. Each step has a clear precondition and output.

## Caveats

Concrete failure modes — specific, not vague.
```
