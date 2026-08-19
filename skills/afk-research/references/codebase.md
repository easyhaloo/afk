# Codebase Research

Investigate the source of truth that lives inside the repository.

## Core principle

For repository-specific behavior, the codebase is the primary source of truth. Model knowledge and documentation provide expectations or context; confirm important claims against the implementation, tests, configuration, and runtime behavior.

## Investigation pattern

1. **Frame** — define the specific question and expected behavior.
2. **Navigate** — inspect the relevant implementation, dependencies, configuration, tests, and documentation.
3. **Trace** — follow the actual execution or dependency path when behavior spans multiple components.
4. **Confirm or disconfirm** — determine whether the evidence supports the expectation.
5. **Record surprises** — contradictions between expectation, documentation, and implementation are findings that should be reported.

## Parallel investigation

When independent code paths or perspectives can answer the question separately, assign them to different agents. Prefer complementary investigations such as implementation, tests, architecture, or dependency analysis rather than duplicating the same search.

Each agent should report concrete evidence, relevant file or symbol locations, and unresolved uncertainty. Agent agreement is not proof; reconcile findings against the repository evidence.

## Evidence depth

Use enough evidence to establish the claim. A simple fact may need only a focused inspection; behavior involving multiple components requires tracing the relevant paths and validating with tests or runtime evidence when available.

## Pivot to Web

If the repository cannot establish the required fact, especially for external behavior, ecosystem conventions, upstream library behavior, or current information, pivot to `web-research.md` and treat external authoritative sources as the new source of truth.
