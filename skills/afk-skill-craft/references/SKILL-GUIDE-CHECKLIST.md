# SKILL-GUIDE Checklist

## Quality Checklist

- [ ] `name` matches directory, lowercase, no consecutive hyphens
- [ ] `description` ≤ 1024 characters, includes trigger keywords
- [ ] Steps reflect actual workflow shape; no formulaic decoration
- [ ] Caveats are concrete (specific failure, not "be careful")
- [ ] No example code or command snippets
- [ ] `SKILL.md` under 500 lines
- [ ] Single responsibility — one skill does one thing
- [ ] Domain-specific terms and values preserved (not abstracted away)

## Constraint Rules

- **LLM-first design**: concise keywords, structured sections, no prose walls
- **Concise description**: description is the **only trigger carrier** — startup loads it for matching, body loads only after activation. Binary judgment, "does X, not Y". Never duplicate trigger logic in body.
- **Body minimization**: detail in references/, SKILL.md is the index
- **Abstraction over explanation**: keyword-driven, trust model priors.

  **Knowledge determination:** LLM knows (1) training data + (2) current context.
  ```
  Decision rule:
    In training data → Abstract (LLM knows it)
    Only in skill file → PRESERVE (LLM knows it only from context)
  ```
  - Training data has it → abstract (e.g., `git commit`, `jest`)
  - Only in skill file → PRESERVE (e.g., `mode::afk`, `afk issue create --label`)
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

Numbered, imperative. Steps reflect actual workflow shape — not every
step needs explicit Precondition/Output labeling.

## Caveats

Concrete failure modes — specific, not vague.
```
