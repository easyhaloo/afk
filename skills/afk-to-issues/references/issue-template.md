# Backlog Issue Body Template

> The body describes the work. Repository association comes from the Issue's
> containing repository and is carried as `targetRepository` metadata in the
> provider-neutral manifest; do not repeat it in this body.
> Audience: coding agents and reviewers.

## Structure

```markdown
# <Outcome-oriented title>

## Context

<problem, why it matters, and intended outcome>

## Base Version

- Base Ref: <explicit ref or inherit repository default when appropriate>
- Base SHA: <resolved at execution start; omit while planning>

## Change Scope

### In Scope
- <grounded modules, behaviors, and relevant tests>

### Out of Scope
- <explicit non-goals and changes requiring separate approval>

## Acceptance Criteria

- [ ] <observable condition> -- <evidence_type> -- <check_command>

## Verification

- <relevant unit / integration / E2E checks and product-behavior checks>

## Dependencies

- <canonical issue IDs after creation, or "none">

## Traceability

- Requirements: <PRD requirement IDs>
- Acceptance Criteria: <PRD AC IDs>
- Business Rules: <PRD BR IDs, when present>
```

## Field Reference

| Field | Required | Purpose |
|---|---|---|
| Title | yes | States the intended outcome, not a commit message |
| Context | yes | Explains the problem and intended result |
| Base Version | when constrained | Records special branch/release constraints; otherwise inherit configured default |
| Change Scope / In Scope | yes | Defines the expected change boundary, grounded in repository analysis |
| Change Scope / Out of Scope | yes | Prevents unrelated changes and scope creep |
| Acceptance Criteria | yes | Observable, bounded, falsifiable success conditions |
| Verification | yes | Explains repository-local and cross-repository validation |
| Dependencies | when applicable | Lists actual execution prerequisites |
| Traceability | yes in PRD Mode | Connects work to approved requirements |

Do not include a Repository field in the body. The Issue is already attached to a
repository. The manifest/provider metadata must identify the target repository
so the Issue is created in the correct place.

## Base Version Rules

- Use the repository's configured default branch when no special version
  constraint is required; do not duplicate that default unnecessarily in the
  body.
- Explicitly state a branch/tag when the task targets a release line, old
  maintenance branch, migration window, or compatibility baseline.
- Resolve and record the actual base commit SHA at execution start. Do not
  guess or freeze a potentially stale SHA during decomposition.
- Branch naming and branch creation are execution workflow concerns unless a
  team policy requires a specific branch pattern.

## Acceptance Criteria Item Format

Each AC item uses three `--`-separated fields:

```markdown
- [ ] <ac_text> -- <evidence_type> -- <check_command>
```

Allowed evidence types: `test`, `curl`, `log`, `manual`, `none`.

The check must be grounded in the actual repository. It must not mutate state,
and must not use an always-success placeholder to pretend that behavior passed.
For `manual`, describe the human check and keep it pending until sign-off.
A passing command alone does not prove product acceptance; the observed
behavior must match the criterion.

## Anti-Patterns

- Repeating repository identity in the Issue body.
- Inventing file paths, commands, APIs, or modules before repository analysis.
- Treating every directory/module as a separate task.
- Omitting explicit non-goals.
- Using an unpinned or wrong release branch when compatibility constraints exist.
- Claiming a Base SHA is known before execution resolves it.
- Using `echo "pass"` or similar commands as acceptance evidence.
- Treating successful unit tests in each repository as proof of an integrated
  cross-repository workflow.
- Using provider IDs in the draft before the provider has created the records.
