---
name: afk-debug
description: >-
  Use when a specific, reproducible failure is provided (command, curl,
  or sequence) and root-cause diagnosis + fix verification is needed.
  Executes in current session with human confirmation at each step.
disable-model-invocation: false
---

# Debug

**Goal:** Root cause identified → fix applied → original input passes.
**Mode:** HITL — proposes hypotheses, traces code, suggests fixes;
human decides the investigation direction.
**Contract:** trigger + actual output → verified fix.

## Core Loop

```
Step 1: Reproduce    → Run the trigger, record the actual error
Step 2: Hypothesize  → List 3-5 possible causes from code analysis
Step 3: Investigate → Trace the code path, narrow to root cause
Step 4: Propose Fix → Show what to change and why; wait for confirmation
Step 5: Verify       → Re-run the original trigger
Step 6: Loop / Done  → Pass → record root cause. Fail → loop back to Step 2
```

## Steps

### Step 0 — Load hard checks (mandatory)

Read `references/hard-checks.md` before starting. Stop immediately if
any hard check is violated.

### Step 1 — Reproduce

Run the provided trigger exactly as given. Capture:
- The exact command or sequence
- The full output (stdout + stderr)
- The exit code

Store via:
```bash
afk debug reproduce "<command>"
```

**Rule:** Do not modify the command before running it.

### Step 2 — Hypothesize

List 3-5 possible causes. Format each as:

```
A. <cause description>
   Evidence: <file:line or log excerpt that points here>
B. <cause description>
   Evidence: <file:line or log excerpt>
```

**Rule:** Do not write code in this step. Present the list and ask
which direction to investigate first.

### Step 3 — Investigate

Follow the chosen hypothesis:
1. Read the relevant code files
2. Trace the call chain from entry point to failure point
3. Identify the specific line or condition that produces the error

State root cause explicitly when confirmed:
> "Root cause: `<file:line>` — `<why this causes the failure>`"

### Step 4 — Propose Fix

Describe:
- **What** will change (file, function, condition)
- **Why** this fixes the root cause
- **What the side effects are**, if any

Wait for user confirmation. Do not proceed without it.

### Step 5 — Verify

Apply the fix, then re-run the original trigger:
```bash
afk debug verify "<original_trigger>"
```

- **Exit 0 + expected output** → verified. Record root cause.
- **Still failing** → loop back to Step 2 with the new evidence.

**Rule:** If the original trigger still fails, the bug is not fixed —
"looks right" is not evidence.

### Step 6 — Done / Loop

**Done:** Original trigger passes. Summarize root cause, what was
changed, how it was verified.

**Loop:** Trigger still fails. Add new evidence and continue from Step 2.

## Script Interface

| Command | What it does |
|---------|--------------|
| `afk debug reproduce "<cmd>"` | Execute command, record output + exit code |
| `afk debug hypothesize` | Display last output, prompt for hypothesis list |
| `afk debug investigate <file> [n]` | Print file content, optionally at line `n` |
| `afk debug propose "<desc>"` | Record proposed fix in state |
| `afk debug verify [cmd]` | Re-run command, update verified field |
| `afk debug status` | Print full state summary |
| `afk debug reset` | Clear state and start fresh |

State files: `.debug/state.json`, `.debug/commands.log`.

## Anti-patterns

- MUST NOT propose a fix before identifying the root cause.
- MUST NOT skip verification — original trigger must pass.
- MUST NOT run destructive commands without warning and waiting for confirmation.
- MUST NOT change the trigger before running it.
