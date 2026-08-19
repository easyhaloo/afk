---
name: afk-grill-me
disable-model-invocation: true
description: Interview ambiguous requirements until there is a shared, falsifiable understanding of the problem, scope, success criteria, and constraints.
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
  Bash(chown*) Bash(mkdir*)
---

# Grill-me

> **Interview:** Turn an ambiguous feature or problem into a shared, falsifiable understanding before implementation. Use interactive questioning to establish **who it is for, what success means, what is explicitly out of scope, and which constraints matter**. Explore deeper only where answers are ambiguous, conflicting, or consequential; do not ask questions merely to make the interview longer.

Use `AskQuestion` for every round and keep the interaction human-in-the-loop. Cover at minimum **Audience, Success Criteria, Non-goals, and Hard Constraints**. Add stakeholders, integrations, data sensitivity, failure handling, rollback, observability, dependencies, or timeline only when they materially affect the solution. Answers should be specific enough that someone can later verify whether the delivered result satisfies them.

Do not assume unstated requirements or silently resolve conflicting stakeholder positions. Preserve unresolved conflicts and questions explicitly. Stop when the core topics have concrete answers and additional questioning produces diminishing returns; if two consecutive rounds add no meaningful constraint or non-goal, proceed with the known information and record the remaining uncertainty as open questions.

Before writing anything, show the proposed context for human review. Require explicit confirmation with one of four outcomes: **Approve, Revise, Drill deeper, or Add open question**. Only approved information may become the final context.

The final context should concisely capture the problem, audience, success criteria, non-goals, constraints, important domain terminology, and unresolved questions. It must contain at least one concrete audience, one falsifiable success criterion, and one explicit non-goal before the interview can be considered complete.

After approval, create an isolated temporary directory and write the confirmed Markdown context there. Do not write to the repository or overwrite an existing artifact:

```bash
CONTEXT_DIR=$(mktemp -d /tmp/afk-grill-me-XXXXXX)
CONTEXT_FILE="$CONTEXT_DIR/CONTEXT.md"
```

Use an appropriate non-interactive mechanism to write the approved context to `$CONTEXT_FILE`, then report its absolute path. Do not use the repository editing tools for this artifact.

> **Principle:** Ask until the requirements become testable, not until the questions run out.
