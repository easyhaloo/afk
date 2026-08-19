# Skill Guide

## Quality

- `name` matches the directory, uses lowercase `a-z`, `0-9`, and single hyphens, and has a clear responsibility.
- `description` is concise, identifies what the skill does and when it applies, and does not contain unnecessary workflow detail.
- `SKILL.md` is focused on behavior and constraints rather than procedural decoration.
- The skill has one clear responsibility and a precise boundary with related skills.
- Domain-specific terminology, values, contracts, and invariants are preserved when required for correct execution.
- Specialized or substantial domain knowledge is placed in `references/` rather than duplicated in `SKILL.md`.
- Instructions are actionable and unambiguous; avoid vague advice and arbitrary thresholds.
- Examples and commands are not embedded merely to explain intent; use scripts or references when executable detail is genuinely required.
- `references/hard-checks.md`, when present, contains only agent-facing prohibitions and escalation rules, not recovery playbooks.
- The skill directory remains self-contained and does not depend on undocumented files outside its boundary.

## Design

### Responsibility

The skill must answer:

- What problem does it solve?
- What is inside its boundary?
- What is explicitly outside its boundary?
- What input does it require?
- What result should it produce?

### Evidence

When creating or improving a skill, inspect the existing implementation, relevant references, related skills, and repository conventions before changing the design.

Judge the skill from evidence rather than from formatting alone. Preserve behavior that is required by the domain, and remove duplication or generic instructions that do not materially improve execution.

### Instructions

Prefer concise, descriptive guidance over rigid step-by-step SOPs. Describe the behavior the agent must achieve, the constraints it must respect, and the conditions under which it should stop, ask, verify, or continue.

Do not encode arbitrary attempt counts, mandatory questions, or implementation mechanisms unless they are required by the domain.

### Knowledge

Separate general model knowledge from repository-specific or domain-specific knowledge. Preserve knowledge that the agent cannot reliably infer from context, and move substantial specialized knowledge into references.

### Safety

Fail closed when a required precondition or critical fact cannot be established. Do not silently invent missing information, override local hard checks, or cross the skill's directory boundary.

## Validation

Before considering a skill complete, verify that:

1. Its responsibility and trigger are clear.
2. Its instructions are sufficient to execute the intended behavior.
3. Related skills do not duplicate or contradict its responsibility.
4. References and `SKILL.md` are consistent.
5. Required domain knowledge and constraints are preserved.
6. No known validation issue remains unresolved.

> **Principle:** Optimize for correct agent behavior, not checklist compliance. The checklist is evidence for review, not a substitute for understanding the skill.
