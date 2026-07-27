# Spike

**Use when:** Proving a technical approach works before committing to
full implementation. Used for unfamiliar systems, risky dependencies,
or "will this even work?" questions.

## Core Principle

Time-boxed exploration. You are not building the feature — you are
answering a specific question. The output is a finding, not a product.

## Step Sequence

1. **Define the spike question** — one specific technical question,
   answerable with yes/no or a concrete measurement. "Can we use X
   instead of Y?" or "Does library Z support feature W?"
2. **Time-box** — one to a few hours maximum. If you have not answered
   the question in that time, document what you tried and stop.
3. **Explore the minimum path to an answer** — write the smallest
   possible code that tests the hypothesis. Delete it after.
4. **Document findings** — what worked, what did not, what you learned.
5. **WIP commit** with the standard Progress format + spike findings.

## WIP Commit Format (spike variant)

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <short description> #<iid>

Progress:
- [x] Spike: <specific question> -- <conclusion, e.g. "YES: library Z supports W"
- [ ] <any follow-up spike needed>

Findings:
- <what you tried>
- <what worked / what did not>

Next: <full implementation plan if applicable>
EOF
)"
```

Valid `<type>` values: `spike`, `wip`.

## Anti-Patterns

- MUST NOT turn a spike into a feature implementation — the spike code
  is disposable, not a draft of the real thing.
- MUST NOT skip the time-box — if the question is not answered in
  time, document partial findings and stop.
- MUST NOT run multiple spikes in one session — one question at a time.
- MUST NOT file a spike commit as the solution to an issue — the spike
  answers a question, the issue asks for a feature.

## When to Use

- Evaluating a new library or service
- Confirming performance characteristics
- Understanding an unfamiliar code path before refactoring
- Verifying a proposed architecture decision
