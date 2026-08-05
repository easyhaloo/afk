# TDD Feature Development

**Use when:** Adding new behavior, API endpoints, data models, or UI
components. The majority of AFK backlog items fall here.

## Core Loop

```
Red  → Write a test that describes the desired behavior. It MUST fail
       before any implementation code exists for this feature.
Green→ Write the minimum implementation to make the test pass.
       No optimization, no future-proofing — only what the test needs.
Refactor → Improve code under test protection.
Repeat → Next AC line.
```

The loop is **mandatory** for every AC line. Skipping Red and writing
implementation directly is non-compliant — see `references/hard-checks.md`
HC-2.

## Step Sequence

1. **Read git log** (`git log --oneline -5`) — know where you are.
2. **Identify AC lines** — each AC maps to at least one test.
3. **Write the first failing test** — Red. Commit with `wip: <desc> (backlog {backlogId})`.
4. **Implement to make it pass** — Green. Commit with `feat: <desc> (backlog {backlogId})`.
5. **Refactor if needed** — commit with `refactor: <desc> (backlog {backlogId})`.
6. **Repeat for each AC**.
7. **Final verification** — run all tests, verify all AC lines satisfied.
8. **WIP commit** with the standard Progress format.

## WIP Commit Format (standard — used by all task types)

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <short description> (backlog {backlogId})

Progress:
- [x] <AC line 1> -- <evidence, e.g. "TestX passes"
- [ ] <AC line 2> -- <status or blocker>

Next: <concrete next action>
EOF
)"
```

Valid `<type>` values: `feat`, `fix`, `refactor`, `wip`.
The `wip:` prefix is used only for intermediate checkpoints, not the
final commit before publishing the provider change.

## Anti-Patterns

- MUST NOT write implementation before writing the failing test first.
- MUST NOT write multiple tests and implement them all at once — one at
  a time keeps the loop tight and the commits atomic.
- MUST NOT skip the Red phase by writing a passing test retroactively —
  that is not TDD, it is just testing after the fact.
- MUST NOT add behavior beyond what the failing test requires.
- MUST NOT commit with only implementation and no test code for that
  behavior on a feature task (HC-2).

## Scope Discipline

- Each WIP cycle targets exactly one AC line.
- If you discover needed work outside AC scope → `TODO:` comment in code,
  do not implement in this run.
- If an AC line is too large → split into sub-steps, write one test at
  a time.
