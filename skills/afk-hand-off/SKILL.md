---
name: afk-hand-off
description: >-
  Use when the current session should snapshot its state so the next
  session resumes immediately without re-explaining context.
  Save mode writes to /tmp/; resume mode reads and continues.
disable-model-invocation: true
disallowed-tools: >-
  Edit(*) NotebookEdit(*)
  Bash(git push*) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
---

# Hand-off + Resume

**Goal:** Zero context loss between sessions.
**Mode:** save (snapshot) or resume (continue from snapshot).

## Mode: save

### Step 1 — Collect

```bash
git status --short
git log --oneline -5
git worktree list 2>/dev/null || true
```

### Step 2 — Draft

Write a **single snapshot**. Do not create a draft and revise — write
once, completely, then stop. Leave sections blank if no content.

```markdown
# Hand-off — <title>

## Goal
<what this session set out to accomplish>

## Where we are
<branch or worktree name>

## What was done
- <concrete action or finding>
- ...

## Key findings
- <analysis, code trace, root cause>

## Key decisions
- <choice between alternatives, with why this option was chosen>

## Next action
<specific next step — concrete enough that another agent could act on it>
```

### Step 3 — Write

Write directly to `/tmp/` using Bash (`cat > /tmp/... << 'EOF'` or `tee`):
```
/tmp/handoff-YYYYMMDD-HHMMSS.md
```
**Do not use the Write tool** — the Write tool requires reading the file
first even for new paths, which is incompatible with `/tmp/` generation.

### Step 4 — Report

Display the path so the user can resume in the next session:
```
/afk-hand-off --resume /tmp/handoff-YYYYMMDD-HHMMSS.md
```

## Mode: resume

### Step 1 — Read

Display the HANDOFF content and confirm it is the right session.

### Step 2 — Confirm next action

Ask: "Is the `Next action` still valid? Has the context changed?"

- **Yes →** proceed to Step 3.
- **No →** discard this HANDOFF and continue work directly. Do not
  edit the HANDOFF file.

### Step 3 — Act

Run the `Verify:` command if present. Then continue from where the
HANDOFF left off.

## Anti-patterns

- MUST NOT write to the repo working tree — only to `/tmp/`.
- MUST NOT omit the `Next action` — a hand-off without a concrete next
  step is a dead end.
- MUST NOT overwrite an existing HANDOFF file — each save is a new file.
- MUST NOT use the Write tool for `/tmp/` output — use Bash (`cat >`, `tee`, or similar) instead. The Write tool requires a prior Read even for new file paths.
