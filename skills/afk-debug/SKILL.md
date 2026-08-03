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

Step 1: Reproduce — run trigger, record error.
Step 2: Hypothesize — list 3-5 possible causes from code analysis.
Step 3: Investigate — trace code path, narrow to root cause.
Step 4: Propose Fix — show what to change and why; wait for confirmation.
Step 5: Verify — re-run original trigger.
Step 6: Loop / Done — pass → record root cause. Fail → loop to Step 2.

## Steps

### Step 0 — Load hard checks (mandatory)

Read `references/hard-checks.md` before starting. Stop immediately if
any hard check is violated.

**Output:** hard-checks loaded.

### Step 1 — Reproduce

Run the provided trigger exactly as given. Capture: exact command or
sequence, full output (stdout + stderr), exit code.

**Rule:** Do not modify the command before running it.

**Output:** captured output and exit code.

### Step 2 — Hypothesize

List 3-5 possible causes with evidence (file:line or log excerpt).

**Rule:** Do not write code in this step. Present the list and ask
which direction to investigate first.

**Output:** hypothesis list.

### Step 3 — Investigate

Follow the chosen hypothesis: read relevant code files, trace call chain
from entry point to failure point, identify specific line or condition.

State root cause explicitly when confirmed: "Root cause: file:line —
why this causes the failure".

**Output:** root cause identified or continue investigating.

### Step 4 — Propose Fix

Describe: what will change (file, function, condition), why this fixes
the root cause, what the side effects are if any.

Wait for user confirmation. Do not proceed without it.

**Output:** proposed fix.

### Step 5 — Verify

Apply the fix, then re-run the original trigger.

- **Exit 0 + expected output** → verified. Record root cause.
- **Still failing** → loop back to Step 2 with the new evidence.

**Rule:** If the original trigger still fails, the bug is not fixed —
"looks right" is not evidence.

**Output:** verified pass/fail.

### Step 6 — Done / Loop

**Done:** Original trigger passes. Summarize root cause, what was
changed, how it was verified.

**Loop:** Trigger still fails. Add new evidence and continue from Step 2.

## Script Interface

Use `afk debug` subcommands: reproduce, hypothesize, investigate,
propose, verify, status, reset. State files: `.debug/state.json`,
`.debug/commands.log`.

## Caveats

- MUST NOT propose a fix before identifying the root cause.
- MUST NOT skip verification — original trigger must pass.
- MUST NOT run destructive commands without warning and waiting for confirmation.
- MUST NOT change the trigger before running it.
