---
name: afk-hand-off
description: Create a compact session handoff so another agent can resume work without replaying the conversation.
disable-model-invocation: true
disallowed-tools: >-
  Edit(*) NotebookEdit(*)
  Bash(git push*) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
---

# Session Handoff

> **Handoff:** Extract the minimum state required for another agent to continue this session without replaying the conversation. Capture the **goal, current progress, completed work, key decisions, pending tasks, blockers, and immediate next action**. Preserve technical context, constraints, file changes, commands, and test results only when they affect continuation. Clearly distinguish **what is done, what remains, and what happens next**. Do not repeat conversation history, reasoning, abandoned approaches, or irrelevant details. The result must be factual, actionable, self-contained, and optimized for immediate continuation.

## Save

Analyze the entire current session and compress it into a concise Markdown handoff that describes the current state of the work. Record the objective, current progress, completed work, important decisions, remaining work, blockers, and the single most appropriate next action. Include technical context, constraints, changed files, commands, or verification results only when they are necessary for the next agent to continue correctly.

Do not summarize the conversation chronologically. Do not include redundant reasoning, abandoned approaches, or information that does not affect continuation. Clearly distinguish completed work from pending work and decisions from findings. The next action must be concrete and immediately executable.

Create a temporary handoff directory and write the generated Markdown snapshot into a uniquely named file:

```bash
HANDOFF_DIR=$(mktemp -d /tmp/afk-handoff-XXXXXX)
HANDOFF_FILE="$HANDOFF_DIR/handoff.md"
```

Write the generated handoff content to `$HANDOFF_FILE` using an appropriate non-interactive command or mechanism. Do not modify the repository working tree or overwrite an existing handoff.

After saving, report the absolute path of the generated handoff file.

## Resume

Read the handoff snapshot and validate its state against the current environment and repository before continuing.

If the state is still consistent, continue directly from the recorded next action. If the state has changed, reassess the remaining work and determine a new next action instead of blindly following the outdated snapshot.

Do not repeat work already recorded as completed.

> **Principle:** Preserve work state, not conversation history.
