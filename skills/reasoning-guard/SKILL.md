---
name: reasoning-guard
description: Detect and interrupt degrading problem-solving paths before repeated failures, unverified assumptions, or regressive changes compound.
disable-model-invocation: true
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*)
---

# Reasoning Guard

> **Reasoning Guard:** Detect when the current problem-solving path is no longer producing reliable progress, especially when errors repeat, fixes regress behavior, assumptions remain unverified, or successive changes increase complexity without resolving the root cause. When detected, stop the current iteration, reassess the goal, assumptions, evidence, failure chain, and smallest corrective change before continuing. Do not blindly repeat failed approaches or use increasingly large changes to compensate for uncertainty. Preserve valid progress, isolate the failing assumption or change, and resume only with a verified corrective direction.

## Detect

Continuously assess whether the current approach is converging toward the intended result. Intervene when there is a meaningful pattern of repeated failure, circular edits, growing complexity without progress, regression, contradictory evidence, or an unverified assumption driving implementation.

Do not rely on a fixed attempt count. Judge the signal from the actual task, evidence, recent changes, failures, and measurable progress.

## Reassess

When the guard triggers, stop making further changes and reassess:

- **Goal:** What outcome must actually be achieved?
- **Assumptions:** Which inputs are verified and which are inferred?
- **Evidence:** What do the code, tests, errors, documentation, and runtime state actually show?
- **Failure:** What changed, what failed, and what causal relationship is supported by evidence?
- **Direction:** Is the current approach still appropriate, or should the approach itself change?

Separate facts from hypotheses and identify the smallest unresolved assumption that could explain the failure.

## Correct

Choose the smallest corrective action that tests or fixes the identified root cause. Prefer a focused change over another broad rewrite. Validate the corrective direction before making additional dependent changes.

Preserve valid progress when it remains compatible with the corrected approach. Do not discard or recreate working changes merely to restart the reasoning process.

Repository rollback is not part of the default guard response. If rollback is genuinely required, determine the safest reversible mechanism for the current repository state rather than performing a destructive reset automatically.

## Continue

Resume normal execution only after the new direction is supported by evidence. If the same failure pattern returns, reassess the approach again instead of repeating the same correction.

Do not trigger repeatedly for the same failure episode once the reasoning path has been corrected; trigger again only when a materially new degradation signal appears.

> **Principles:** Stop before compounding errors. Question the approach, not just the latest edit. Prefer evidence over assumptions. Fix the root cause with the smallest sufficient change. Validate before continuing.
