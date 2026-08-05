# TDD Refactor

**Use when:** Improving code structure (renaming, extracting, splitting)
without changing observable behavior.

## Core Principle

The existing test suite is your safety net. If no tests exist for the
code you are touching, write them first (treat as Feature TDD), then
refactor.

## Step Sequence

1. **Read git log** — know where you are.
2. **Verify existing tests pass** — run the full test suite. Do not
   touch anything until it is green.
3. **Identify refactoring target** — a specific structural improvement,
   named precisely.
4. **Write regression tests if no coverage exists** — treat as Feature
   TDD first (Red → Green).
5. **Refactor in small atomic steps** — each step leaves tests green.
   Commit after each change.
6. **Final test run** — all tests still pass.
7. **WIP commit** with the standard Progress format.

## WIP Commit Format (standard — used by all task types)

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <short description> (backlog {backlogId})

Progress:
- [x] <AC line 1> -- <evidence, e.g. "all existing tests pass"
- [ ] <refactor target 2> -- <status or blocker>

Next: <concrete next action>
EOF
)"
```

Valid `<type>` values: `refactor`, `feat` (for new test coverage), `wip`.

## Anti-Patterns

- MUST NOT change behavior while refactoring — if you want to add
  behavior, record a separate backlog item or mark it as a `TODO:` comment.
- MUST NOT refactor on red tests — you are guessing, not engineering.
- MUST NOT do a big-bang refactor — one small change at a time, commit
  each, keep tests green throughout.
- MUST NOT rename across a large surface area in one commit — use
  multiple atomic commits.

## Scope Discipline

- One refactoring target per WIP cycle.
- If the code has no tests and you cannot write them (e.g., legacy code
  with hidden dependencies), treat it as a Spike first to understand
  the risk before committing to a refactor.
