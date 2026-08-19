---
name: afk-diagnose
description: Diagnose a specific failure by reproducing it, analyzing code and documentation, establishing an evidence-backed root cause, and verifying the smallest safe fix.
disable-model-invocation: false
disallowed-tools: >-
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker rm -f*) Bash(rm -rf*)
---

# Diagnose

> **Diagnosis:** Investigate a reproducible failure by building an evidence-backed causal explanation before changing the system. Reproduce the failure when possible, inspect the actual error, trace the relevant execution path, and use code, documentation, configuration, tests, and runtime evidence to distinguish facts from hypotheses. Do not treat a plausible explanation as a root cause. Once the causal failure is established, propose the smallest corrective change, obtain confirmation before modifying the system, and verify the original failure path after the change. If verification fails, use the new evidence to reassess the diagnosis rather than repeating the same fix.

## References

Before starting diagnosis, inspect all relevant documents under `references/`. Treat their rules and constraints as part of the diagnostic contract throughout the investigation.

References may define hard checks, safety constraints, environment-specific rules, diagnostic procedures, or verification requirements. Do not ignore or silently override them. If a reference conflicts with the current diagnosis or proposed action, stop and resolve the conflict before proceeding.

## Diagnose

### Reproduce

Run the original trigger without modification whenever possible. Capture the actual command or sequence, input, output, exit status, relevant environment, and runtime state. If reproduction is impossible, record why and clearly distinguish direct evidence from inferred evidence.

Do not alter the trigger merely to make it pass.

### Investigate

Inspect the relevant codebase, documentation, configuration, dependencies, tests, logs, and runtime behavior before forming or prioritizing explanations. Trace the failure from symptom through the relevant execution path toward its cause.

Form hypotheses only when the available evidence does not establish the cause directly. Prioritize explanations that are supported by evidence and can be efficiently verified. Do not require an arbitrary number of hypotheses and do not ask the user to choose an investigation path unless the decision cannot be determined from available evidence.

### Establish Root Cause

A root cause must explain the observed failure through an evidence-supported causal relationship. Do not label a plausible cause as confirmed merely because a change appears to improve the symptom.

Separate:

- **Observed facts** — directly established by code, logs, tests, documentation, or runtime behavior.
- **Hypotheses** — possible explanations not yet verified.
- **Root cause** — the causal explanation supported by sufficient evidence.
- **Uncertainty** — relevant questions that remain unresolved.

When multiple independent explanations remain plausible, continue targeted investigation rather than guessing.

### Propose and Apply Fix

Once the root cause is established, propose the smallest sufficient change and explain what will change, why it addresses the cause, and any relevant side effects. Obtain user confirmation before modifying the system.

Preserve unrelated working changes. Do not use destructive operations as a shortcut; follow the applicable reference constraints and request confirmation when required.

### Verify

Re-run the original failure trigger whenever possible and verify the expected behavior, not merely a different successful command. Inspect relevant tests or checks when they provide additional confidence.

A fix is not verified because the code looks correct or because another test passes. The original failure must be resolved, or the verification gap must be explicitly reported.

If the original failure remains or a regression appears, treat the result as new evidence, reassess the causal model, and continue from investigation rather than repeating the same fix.

## Output

Report the final diagnosis concisely:

- Root cause and supporting evidence
- Change applied and why
- Verification performed and result
- Remaining uncertainty or verification gaps

> **Principles:** Evidence before assumptions. Diagnose before fixing. Root cause requires causal evidence. Prefer the smallest sufficient change. Verify the original failure. Never repeat a failed approach without new evidence.
