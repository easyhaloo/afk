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

Run: git status, git log, git worktree list.

### Step 2 — Draft

Write a **single snapshot**: Goal, Where we are, What was done, Key
findings, Key decisions, Next action. Do not create a draft and revise —
write once, completely, then stop. Leave sections blank if no content.

### Step 3 — Write

Write directly to `/tmp/` using Bash (cat or tee). Do NOT use the Write
tool — it requires reading the file first even for new paths.

### Step 4 — Report

Display the path so the user can resume in the next session.

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

## Caveats

- MUST NOT write to the repo working tree — only to `/tmp/`.
- MUST NOT omit the `Next action` — a hand-off without a concrete next
  step is a dead end.
- MUST NOT overwrite an existing HANDOFF file — each save is a new file.
- MUST NOT use the Write tool for `/tmp/` output — use Bash (`cat >`, `tee`, or similar) instead. The Write tool requires a prior Read even for new file paths.

## Browser Session Handoff

When the work involves an authenticated browser session, the snapshot
must capture enough detail for the next session to resume without
re-authentication.

**Include in the snapshot:**

| Field | What to record |
|-------|----------------|
| `Browser CDP endpoint` | `http://127.0.0.1:9222` (or whatever port) |
| `Browser profile path` | e.g. `/Users/<user>/.afk-browser-profile` |
| `playwright-cli session` | e.g. `playwright-cli -s=afk attach --cdp=http://127.0.0.1:9222` |
| `Logged-in origins` | list of origins (e.g. `geelib.qihoo.net`, `www.aiwanwu.cc`) |
| `Token expiry notes` | short-lived cookies/JWTs that will force re-login, with timestamps |

**Recovery on resume:**

1. Check the browser is still running: `curl http://127.0.0.1:9222/json/version`.
2. If dead, restart with the recorded profile path:
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --user-data-dir=/Users/<user>/.afk-browser-profile \
     --remote-debugging-port=9222 about:blank &
   ```
3. Verify logged-in origins still work — short-lived tokens may have
   expired during the gap. If so, the user must re-login before the
   resumed task can proceed.

**Do NOT include** raw cookies, JWTs, refresh tokens, or other secrets
in the HANDOFF. Reference files by path instead; remind the user to
`chmod 600` them.
