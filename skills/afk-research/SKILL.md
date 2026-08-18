---
name: afk-research
description: Investigate questions through independent evidence paths, using parallel agents and cross-validation when useful, before drawing conclusions or committing to a plan.
disallowed-tools: >-
  Edit(*) Write(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*)
---

# Research

> **Research:** Investigate the question through independent evidence paths before drawing conclusions. Analyze the codebase, documentation, tests, configuration, runtime behavior, and external sources as appropriate. When the problem has independent research paths, use multiple agents in parallel to explore them from different perspectives, then cross-check and reconcile their findings. Distinguish verified facts, assumptions, contradictions, and unknowns, and prefer independently corroborated evidence over a single agent's conclusion. Synthesize the validated findings into a concise, evidence-backed conclusion without silently making product or implementation decisions.

## Investigate

First determine what must be established to answer the question and identify independent research paths. Prioritize the strongest available evidence: repository evidence for repository-specific behavior and authoritative external sources for external facts.

Possible paths include:
- Codebase and implementation
- Architecture and dependencies
- Documentation and existing decisions
- Tests and runtime behavior
- External documentation and authoritative sources
- Alternative approaches and feasibility

Use sequential investigation when one finding is required to determine the next path.

## Parallel Research

When paths are independent, delegate them to multiple agents in parallel. Prefer diversity of evidence and perspective over duplicating the same investigation. Give each agent a focused research question and require supporting evidence.

Parallel agents are investigators, not voters. Agreement between agents is not proof; they may share the same incorrect assumption.

## Cross-Validation

After parallel exploration:

1. Collect each agent's findings and supporting evidence.
2. Cross-check important claims against independent sources.
3. Identify agreement, contradiction, missing evidence, and unsupported assumptions.
4. Resolve contradictions by inspecting stronger or additional evidence.
5. Separate verified facts, evidence-based findings, hypotheses, and unknowns.
6. Synthesize only after the evidence has been reconciled.

Prefer evidence that can independently corroborate a claim. Explicitly report unresolved contradictions or uncertainty rather than forcing consensus.

## Output

Produce a concise research result containing the question, key findings, supporting evidence, important contradictions or uncertainties, and evidence-backed conclusions. State what remains unknown when it affects the decision or next step.

Do not make product decisions or implement production changes as part of research. A minimal proof of concept is allowed only when feasibility cannot otherwise be established.

> **Principles:** Investigate before concluding. Parallelize independent paths. Agents explore; evidence validates. Cross-check important claims. Never turn consensus into proof. Report uncertainty explicitly.
