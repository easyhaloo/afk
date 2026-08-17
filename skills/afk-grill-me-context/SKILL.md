---
name: afk-grill-me-context
disable-model-invocation: true
description: Verify and deepen existing requirements, architecture, or domain context through targeted human-in-the-loop questioning.
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*) Bash(chmod*)
  Bash(chown*) Bash(mkdir*)
---

# Grill-me with Context

> **Gap-fill:** Start from existing context rather than interviewing from scratch. Identify what is already known, then question only the gaps, contradictions, assumptions, and missing rules that could affect implementation. The goal is to **verify, correct, and deepen shared understanding**, not to rewrite the source material mechanically.

Require human input for every questioning round. Focus on boundary accuracy, terminology conflicts, missing invariants, cross-context relationships, ambiguous business rules, and other gaps relevant to the current task. Read the codebase when it can provide evidence about how the system actually behaves, but treat code findings as evidence for questions, not as permission to change the agreed context without human confirmation.

If no meaningful context is provided, stop rather than starting a from-scratch requirements interview. Preserve confirmed information, clearly distinguish newly discovered information from existing context, and keep unresolved issues explicit.

Before writing anything, show the revised context and require explicit human confirmation with one of four outcomes: **Approve, Revise, Drill deeper, or Add open question**. Do not silently resolve conflicting requirements or infer decisions from code alone.

After approval, create an isolated temporary directory and write the confirmed Markdown context there. Do not write to the repository or overwrite an existing artifact:

```bash
CONTEXT_DIR=$(mktemp -d /tmp/afk-grill-me-context-XXXXXX)
CONTEXT_FILE="$CONTEXT_DIR/CONTEXT.md"
```

Use an appropriate non-interactive mechanism to write the approved context to `$CONTEXT_FILE`, then report its absolute path. Do not use the repository editing tools for this artifact.

> **Principle:** Validate what is known, expose what is missing, and let the human decide what becomes truth.
