---
name: afk-skill-craft
disable-model-invocation: true
description: >-
  Create a new SKILL.md, diagnose an existing one for quality issues,
  or refactor to align with SKILL-GUIDE standards.
  Trigger: user asks to create, audit, or improve a skill.
---

# Skill Craft

**Goal:** create, diagnose, or refactor a SKILL.md per local checklist.

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

Read `references/SKILL-GUIDE-CHECKLIST.md` for frontmatter rules.
Draft: `name`, `description` (≤1024 chars, binary judgment, trigger keywords).

### Step 3 — Identify structure needs

Per directory structure in checklist:
- `scripts/` if executable code needed
- `references/` if detailed docs needed
- `assets/` if templates/resources needed

Create directories as needed.

### Step 4 — Draft body

Per body structure in checklist: **Goal**, **Steps**, **Caveats**.
**Critical:** Do not add formulaic Precondition/Output to every step.
Only add when workflow has complex dependencies.
**Critical:** Preserve domain-specific terms and values — do not abstract
`mode::afk` to "mode label", `stage::ready-for-issues` to "stage label", etc.

### Step 5 — Verify

Run through checklist quality items. Fix any failures before reporting.

---

## Mode: Diagnose

### Step 1 — Read SKILL.md

Parse frontmatter fields. Read `references/SKILL-GUIDE-CHECKLIST.md`.

### Step 2 — Run checklist

For each quality item, report pass/fail:
- `name` matches directory, lowercase, no consecutive hyphens
- `description` ≤ 1024 characters, includes trigger keywords
- Steps reflect actual workflow shape; no formulaic decoration
- Caveats are concrete
- No example code or command snippets
- `SKILL.md` under 500 lines
- Single responsibility
- **Domain-specific terms and values preserved**

### Step 3 — Check constraint rules

Flag violations:
- Abstraction applied to domain terms the LLM doesn't know (e.g., `mode::afk` abstracted to "mode label")
- Precondition/Output added as formulaic decoration when workflow is linear/obvious
- Example code or commands present
- Ambiguous language in steps

### Step 4 — Report

Present findings as actionable issue list with severity tag per item.
Suggest fixes. Do not auto-fix unless user confirms.

---

## Mode: Refactor

### Step 1 — Diagnose first

Run Diagnose mode.

### Step 2 — Apply checklist rules

Per Diagnose findings. Pay special attention to:
- Domain-specific terms abstracted away → restore concrete values
- Formulaic Precondition/Output decoration → remove if workflow is linear
- Example code blocks → replace with intent descriptions

### Step 3 — Verify

Run Diagnose mode again. All items pass → refactor complete.

---

## Caveats

- MUST NOT create a skill without confirming name with user
- MUST NOT auto-apply fixes without user confirmation in Diagnose mode
- MUST NOT read files outside own directory or network URLs
- Output location: `skills/<name>/` for created skill; `/tmp/` for drafts
