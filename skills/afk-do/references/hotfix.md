# Hotfix

**Use when:** Fixing a live production bug under time pressure. Speed over
structure — but still must verify the fix works before closing.

## Core Principle

Minimal change that addresses the reported problem. No new behavior,
no refactoring, no feature expansion.

## Step Sequence

1. **Reproduce the bug** — confirm it exists before touching any code.
   If you cannot reproduce it, you cannot verify the fix.
2. **Identify the root cause** — not the symptom. A one-line symptom fix
   often recurs; a root-cause fix does not.
3. **Write a test that fails with the bug** — Red. If the code area has
   no existing test coverage, add a regression test.
4. **Apply the minimal fix** — Green. Only what stops the symptom.
5. **Verify fix** — test passes, bug no longer reproduces.
6. **WIP commit** with the standard Progress format.

## WIP Commit Format (standard — used by all task types)

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <short description> (backlog {backlogId})

Progress:
- [x] <AC line 1> -- <evidence, e.g. "regression test passes, bug reproduced then fixed"
- [ ] <AC line 2> -- <status or blocker>

Next: <concrete next action>
EOF
)"
```

Valid `<type>` values: `hotfix`, `fix`, `feat` (for regression test), `wip`.

The `Progress:` lines describe the bug being fixed and the evidence that
it is fixed (e.g. "regression test passes", "verified manually").

## Anti-Patterns

- MUST NOT add new behavior while fixing — even if "while you're in
  there anyway". Record a separate backlog item.
- MUST NOT skip reproduction — fixing blind is guessing.
- MUST NOT use a hotfix as an excuse to skip testing — regression
  test is mandatory if the area had no test coverage.
- MUST NOT mark the backlog done without verifying the fix does not break
  existing behavior.

## Scope Discipline

- One bug per commit. If you find additional bugs, note them and
  treat them as separate backlog items.
- If the minimal fix requires touching stable code you do not own,
  consider whether a proper feature fix (not hotfix) is more
  appropriate.
