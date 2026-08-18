---
name: afk-skill-craft
disable-model-invocation: true
description: Create or improve a skill by analyzing its purpose, implementation, references, and repository conventions, then making the smallest changes needed to produce a focused, reusable, validated skill.
---

# Skill Craft

> **Skill Craft:** Create or improve a skill by first understanding its purpose, existing implementation, references, repository conventions, and related skills. Identify the smallest changes needed to make the skill clear, focused, reusable, and consistent with local design principles. Preserve valid domain knowledge, move detailed knowledge into references when appropriate, avoid procedural or redundant instructions, and validate the resulting skill against its intended behavior and local conventions.

## Inspect

Determine whether the task is to create a new skill, diagnose an existing skill, or improve an existing implementation from the user's intent and available repository evidence. Do not force the user to select a mode when the intent is clear.

For an existing skill, inspect its complete directory context before changing it, including `SKILL.md`, relevant `references/`, `scripts/`, `assets/`, and closely related skills. Read applicable local guidance before judging the implementation.

For a new skill, inspect related skills and repository conventions before designing its structure. Reuse established patterns only when they serve the new skill's responsibility.

## Understand

Define the skill's single responsibility, trigger boundary, input/output contract, required domain knowledge, safety constraints, and relationship to neighboring skills.

Separate repository conventions from domain-specific knowledge. Preserve information that is necessary for the agent to perform the task correctly; remove repetition, generic advice, and implementation detail that can be inferred or maintained elsewhere.

Use `references/` for substantial or specialized knowledge that should not burden the main instruction. Keep `SKILL.md` focused on behavior, constraints, and navigation.

## Improve

Identify the smallest changes that materially improve correctness, clarity, reliability, or reuse. Prefer descriptive instructions over rigid SOPs, examples, arbitrary thresholds, and duplicated rules.

Do not silently change the skill's intended responsibility. When requirements or existing behavior conflict and cannot be resolved from repository evidence, surface the ambiguity before making a consequential design decision.

Preserve valid terminology, values, contracts, and domain-specific behavior unless there is evidence they are incorrect or obsolete.

## Validate

Validate the result against the skill's intended behavior, frontmatter, local conventions, relevant references, and neighboring skills. Check that the skill has one clear responsibility, a precise trigger, sufficient instructions to execute correctly, no unnecessary procedural detail, and no contradictions between `SKILL.md` and its references.

If a `references/hard-checks.md` exists or is needed, keep it focused on agent-facing prohibitions and escalation rules. Put recovery procedures or operational playbooks elsewhere.

Do not claim completion while known validation failures remain unresolved. Report important remaining uncertainty explicitly.

> **Principles:** Inspect before changing. Understand responsibility before structure. Preserve necessary knowledge. Prefer minimal, descriptive instructions. Keep domain detail in references. Validate behavior, not just formatting.
