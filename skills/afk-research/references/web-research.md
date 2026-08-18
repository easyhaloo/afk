# Web Research

Investigate the source of truth that lives outside the repository.

## Core principle

External sources supplement model knowledge and repository evidence. For claims about current products, upstream libraries, standards, ecosystem practice, or information not established by the repository, prefer authoritative and directly relevant external sources.

## Investigation pattern

1. **Frame** — define the claim or question that requires external evidence.
2. **Search** — use targeted queries to locate relevant sources.
3. **Fetch** — inspect the strongest and most directly relevant sources rather than relying on search snippets.
4. **Confirm or disconfirm** — determine whether the external evidence supports the claim.
5. **Cross-check** — use independent sources for important, disputed, or time-sensitive claims.
6. **Record uncertainty** — report conflicting or insufficient evidence instead of forcing a conclusion.

## Parallel investigation

When independent external research paths exist, delegate them to multiple agents with distinct questions or source types. Examples include official documentation, standards, release notes, technical analyses, and independent reports.

Agents should provide the source, relevant evidence, and the claim it supports. Agreement between agents is not sufficient without evidence; reconcile conflicting findings against source authority, recency, and directness.

## Evidence depth

Use enough sources to establish the claim. Focused factual questions may need one authoritative source; architecture, trade-off, feasibility, or disputed questions should use multiple independent sources.

For time-sensitive information, prefer current sources and explicitly account for publication or update dates.

## Pivot to Codebase

If the question concerns how an external technology is actually implemented or configured in this repository, pivot to `codebase.md` and treat the repository as the primary source of truth.
