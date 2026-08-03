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

**Output:** confirmed `name`.

### Step 2 — Draft frontmatter

Read `references/SKILL-GUIDE-CHECKLIST.md` for frontmatter rules.

**Precondition:** name confirmed in Step 1.
**Output:** frontmatter YAML.

### Step 3 — Identify structure needs

Per directory structure in checklist:
- `scripts/` if executable code needed
- `references/` if detailed docs needed
- `assets/` if templates/resources needed

Create directories as needed.

**Precondition:** frontmatter drafted.
**Output:** directories created.

### Step 4 — Draft body

Per body structure in checklist.

**Precondition:** directories identified.
**Output:** SKILL.md body draft.

### Step 5 — Verify

Run through checklist quality items.

**Output:** verified `SKILL.md`.

---

## Mode: Diagnose

### Step 1 — Read SKILL.md

Parse frontmatter fields. Read `references/SKILL-GUIDE-CHECKLIST.md`.

**Output:** parsed frontmatter.

### Step 2 — Run checklist

For each quality item, report pass/fail.

**Output:** checklist results.

### Step 3 — Check constraint rules

Flag violations per constraint rules in checklist.

**Output:** violation list.

### Step 4 — Report

Present findings as actionable issue list:
```
1. [FAIL] description exceeds 1024 chars
2. [WARN] Step 3 lacks precondition
3. [FAIL] Caveats use vague language
```

Suggest fixes. Do not auto-fix unless user confirms.

**Output:** issue list to user.

---

## Mode: Refactor

### Step 1 — Diagnose first

Run Diagnose mode.

### Step 2 — Apply checklist rules

Per Diagnose findings.

### Step 3 — Verify

Run Diagnose mode again. All items pass → refactor complete.

---

## Caveats

- MUST NOT create a skill without confirming name with user
- MUST NOT auto-apply fixes without user confirmation in Diagnose mode
- MUST NOT read files outside own directory or network URLs
- Output location: `skills/<name>/` for created skill; `/tmp/` for drafts
