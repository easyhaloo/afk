# Issue Template

> The authoritative structure for AFK-tracked issues.
> Audience: LLM agents writing issues, NOT human readers.
> Optimize for: stable token structure, parseable fields, machine-checkable AC.

## When to Use

When creating an issue that the autonomous workflow will process.

## Structure

```markdown
# <Title>

## Context

<one paragraph: what problem, why now>

## Acceptance Criteria

- [ ] <ac_text> -- <evidence_type> -- <check_command>
- [ ] <ac_text> -- <evidence_type> -- <check_command>

## Out of Scope

<bulleted list of explicit non-goals>

## Dependencies

<bulleted list of `blocks-<iid>` references, or "none">
```

## Field Reference

| Field | Required | Format | Purpose |
|-------|----------|--------|---------|
| `# <Title>` | yes | one line | Issue name |
| `## Context` | yes | one paragraph | Why this work |
| `## Acceptance Criteria` | yes | list (≥1 item) | Machine-verifiable success |
| `## Out of Scope` | no | list | Prevent scope creep |
| `## Dependencies` | no | list or `none` | Execution ordering |

## Acceptance Criteria Item Format

Each AC item is a single line with three `--`-separated fields:

```
- [ ] <ac_text> -- <evidence_type> -- <check_command>
```

### Field 1: `ac_text`

The condition being verified. Must be:
- **Verifiable** (someone can point at shipped behavior and say "yes/no")
- **Atomic** (one observable fact, not "and also...")
- **Bounded** (no time/person pronouns like "developer feels")

**Bad:** "code looks clean", "works correctly", "user is happy"
**Good:** "API returns 200 for GET /health", "Login form rejects empty email"

### Field 2: `evidence_type` (controlled vocabulary)

Exactly one of:

| Value | Meaning | Use when |
|-------|---------|----------|
| `test` | Automated unit/integration test | Code behavior |
| `curl` | HTTP request assertion | API endpoints |
| `log` | Process log line check | Background workers |
| `manual` | Human inspection required | UI / copy / a11y |
| `none` | Declarative; no runtime check | Removal / refactor |

### Field 3: `check_command`

Shell command that **exits 0 on PASS, non-zero on FAIL**.

Examples:
- `npm test -- --testPathPattern=auth/login` (test)
- `curl -fsS http://localhost:3000/health` (curl)
- `grep -q "ERROR" /var/log/worker.log` (log)
- `echo "manual review needed"` (manual — always exits 0; gate is human signoff)
- `! grep -rn "TODO" src/` (none — declarative; command verifies a property)

## Examples

### Complete issue

```markdown
# Add user login endpoint

## Context

Users currently have no way to authenticate. Need a POST /api/login
endpoint that accepts email + password and returns a JWT.

## Acceptance Criteria

- [ ] POST /api/login with valid creds returns 200 + JWT -- curl -- curl -fsS -X POST -H "Content-Type: application/json" -d '{"email":"a@b.c","password":"x"}' http://localhost:3000/api/login | jq -e .token
- [ ] POST /api/login with bad password returns 401 -- curl -- curl -fsS -o /dev/null -w "%{http_code}" -X POST ... | grep -q 401
- [ ] AuthService.validatePassword unit tests pass -- test -- npm test -- --testPathPattern=auth
- [ ] Rate-limit: 6th request in 1min returns 429 -- curl -- for i in {1..6}; do curl ...; done | tail -1 | grep -q 429

## Out of Scope

- Refresh token rotation
- OAuth providers
- Password reset flow

## Dependencies

none
```

### Minimal issue (no optional fields)

```markdown
# Remove deprecated /v1/users endpoint

## Context

/v1/users is unused; cleaning up before v2 release.

## Acceptance Criteria

- [ ] No source file imports from v1/users -- none -- ! grep -rn "v1/users" src/

## Out of Scope

- Migrating any v1 data
```

## Anti-Patterns

- MUST NOT include `- [x]` items (everything starts unchecked)
- MUST NOT put `--` inside `ac_text` (breaks 3-field parse)
- MUST NOT use evidence types outside the controlled vocabulary
- MUST NOT write `check_command` that mutates state without `--dry-run`
- MUST NOT add AC items that have no observable check

## Parsing

Issue template is parsed by `WorkflowRunner.verifyAC()` and
`parseACLegacy()` in `src/lib/core/tracker/ac.ts`. The template
format is the source of truth — change the parser only when changing
this document.