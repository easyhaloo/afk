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
**Critical:** Preserve canonical backlog terms and values (`ready`,
`in_progress`, `verification`, `merge_ready`, `done`, `blocked`; `afk` or
`hitl`). Do not expose provider adapter labels in skill instructions.

### Step 5 — Verify

Run through checklist quality items. Fix any failures before reporting.
If the skill has or needs `references/hard-checks.md`, keep it rules-only
(ID + one-line prohibition + escalation). Put recovery how-to in a separate
HITL file if needed.

---

## Mode: Diagnose

### Step 1 — Read SKILL.md

Parse frontmatter fields. Read `references/SKILL-GUIDE-CHECKLIST.md`.

### Step 2 — Run checklist (with reasoning)

Read `references/SKILL-GUIDE-CHECKLIST.md`. Apply each quality item
with explicit reasoning:

1. **Read the item.** What does it require?
2. **Find evidence.** Where in the SKILL.md is the relevant content?
3. **Reason.** Does this actually pass? What could be wrong?
4. **Mark.** Then mark pass/fail — not before reasoning.

If `references/hard-checks.md` exists, check the hard-checks style item:
rules-only vs long command recovery playbooks.

### Step 3 — Check constraint rules (with reasoning)

Read `references/SKILL-GUIDE-CHECKLIST.md` constraint rules section.
For each rule, **think before flagging**:

1. **Read the rule.** What does it prevent?
2. **Scan the SKILL.md** (and hard-checks references if present).
3. **Self-reflect.** Am I flagging correctly? Could this be a false positive?
4. **Reason through examples.** If rule says "no example code", trace through every code block and confirm: intent description or an example?

Flag violations only after explicit reasoning.

### Step 4 — Report

Present findings as actionable issue list with severity tag per item.
For each item: state **why** it failed, not just that it failed.
Suggest fixes. Do not auto-fix unless user confirms.

---

## Mode: Refactor

### Step 1 — Diagnose first

Run Diagnose mode.

### Step 2 — Apply checklist rules (with reasoning)

Per Diagnose findings. Read `references/SKILL-GUIDE-CHECKLIST.md` for
constraint rules. For each finding:

1. **Understand the issue.** What is the actual problem?
2. **Trace the cause.** Why did this happen? Is it a false positive?
3. **Apply the fix.** Does the fix introduce new issues?
4. **Self-reflect.** Did the fix make it better or worse?

When fixing hard-checks: strip recovery bash into `hard-checks-recovery.md`
(or drop it); leave agent-facing hard-checks as the rules table only.

### Step 3 — Verify

Run Diagnose mode again. All items pass → refactor complete.

---

## Caveats

- MUST NOT create a skill without confirming name with user
- MUST NOT auto-apply fixes without user confirmation in Diagnose mode
- MUST NOT read files outside own directory or network URLs
- Output location: `skills/<name>/` for created skill; `/tmp/` for drafts
