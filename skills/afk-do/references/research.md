# Research

**Use when:** Investigating a topic, comparing options, or evaluating
technologies. The output is a decision record, not code.

## Core Principle

Structured investigation with a conclusion. Every research task has
a question it set out to answer — the commit is proof that you answered it.

## Step Sequence

1. **Define the research question** — one specific question, not a
   broad topic. "Should we use X or Y for Z?" not "evaluate frontend
   frameworks."
2. **Gather evidence** — read docs, run benchmarks, query existing code,
   consult colleagues or LLM. Cite sources.
3. **Compare options** — against the success criteria defined in the
   question.
4. **Form a recommendation** — with rationale. If uncertain, present
   both options and the trade-off.
5. **WIP commit** with the standard Progress format + research findings.

## WIP Commit Format (research variant)

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <short description> #<iid>

Progress:
- [x] Research: <specific question> -- <conclusion, e.g. "Recommendation: X"
- [ ] <any follow-up research needed>

Question: <what we set out to answer>
Criteria: <how we evaluated options>
Evidence:
- <source 1>: <finding>
- <source 2>: <finding>

Recommendation: <chosen option with rationale>
Alternatives considered: <brief note on other options>

Next: <follow-up if any>
EOF
)"
```

Valid `<type>` values: `research`, `wip`.

## Anti-Patterns

- MUST NOT produce a research commit without a clear question — a
  dump of links and notes is not research.
- MUST NOT leave the question unanswered — if you hit a dead end,
  document that and explain why the question is unanswerable in this
  context.
- MUST NOT let research expand into implementation — if the research
  reveals a feature needs building, file a separate issue.
- MUST NOT skip citing sources — a recommendation without evidence is
  an opinion, not a decision.

## Scope Discipline

- One question per research run.
- If you discover related questions while investigating, note them as
  "follow-up research needed" in the Progress section.
