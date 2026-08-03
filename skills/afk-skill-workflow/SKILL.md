---
name: afk-skill-workflow
disable-model-invocation: true
description: >-
  Create a new SKILL.md, diagnose an existing one for quality issues,
  or refactor to align with SKILL-GUIDE standards.
  Trigger: user asks to create, audit, or improve a skill.
---

# Skill Workflow

**Goal:** create, diagnose, or refactor a skill following the SKILL-GUIDE.

## Modes

| Mode | Entry | Output |
|------|-------|--------|
| **Create** | New skill needed | `skill-name/SKILL.md` |
| **Diagnose** | Check existing skill quality | Issue list with fix suggestions |
| **Refactor** | Improve existing skill | Updated `SKILL.md` |

Ask user which mode. If unclear, describe the three and let user pick.

---

## Mode: Create

### Step 1 — Name the skill

`name` must be lowercase, `a-z/0-9/-` only, 1-64 chars, matching directory.
Confirm name with user before proceeding.

### Step 2 — Draft frontmatter

```yaml
---
name: skill-name
description: >-
  One sentence: what it does and when to invoke it.
---
```

### Step 3 — Identify structure needs

Check SKILL-GUIDE directory structure:
- `scripts/` if executable code needed
- `references/` if detailed docs needed
- `assets/` if templates/resources needed

Create directories as needed.

### Step 4 — Draft body

Follow SKILL-GUIDE body structure:
```
**Goal:** input → output contract.

## When to use

Precise triggers. "When X, not when Y."

## Steps

Numbered, imperative. Precondition + output per step.

## Caveats

Specific failure modes — not vague warnings.
```

### Step 5 — Verify

Run through SKILL-GUIDE quality checklist:
- `name` matches directory
- `description` ≤ 1024 chars, binary judgment
- Steps have preconditions and outputs
- Caveats are concrete
- Body minimized, detail in linked files

---

## Mode: Diagnose

### Step 1 — Read SKILL.md

Parse frontmatter: `name`, `description`, any custom fields.

### Step 2 — Run checklist

For each item in SKILL-GUIDE quality checklist, report pass/fail.

### Step 3 — Check constraint rules

Flag violations:
- Ambiguous language in steps
- Missing output location
- Example code or commands
- Scope too broad

### Step 4 — Report

Present findings as an actionable issue list:
```
1. [FAIL] description exceeds 1024 chars
2. [WARN] Step 3 lacks precondition
3. [FAIL] Caveats use vague language
```

Suggest fixes, don't auto-fix unless user confirms.

---

## Mode: Refactor

### Step 1 — Diagnose first

Run Diagnose mode. Apply fixes identified.

### Step 2 — Apply SKILL-GUIDE rules

Re-iterate:
- Abstract keywords over verbose explanations
- Move detailed content to `references/`
- Binary judgment in description
- Concise steps with preconditions

### Step 3 — Verify

Run Diagnose mode again. All items pass → refactor complete.

---

## Caveats

- MUST NOT create a skill without confirming name with user
- MUST NOT auto-apply fixes without user confirmation in Diagnose mode
- MUST NOT move domain knowledge into SKILL.md — keep in `references/`
- MUST NOT read files outside the target skill directory or network URLs
