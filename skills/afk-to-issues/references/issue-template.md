# Backlog Item Contract

> Use this structure when composing a child backlog item through AFK CLI. It
> defines the information an executor needs; AFK owns provider publication,
> canonical IDs, and returned URLs.

## Structure

```markdown
# <Title>

## PRD

<source PRD artifact and [root backlog](<rootBacklogUrl>)>

## Context

<why this work exists and the intended outcome>

## Scope

<what is included and the relevant repository change surface>

## Acceptance Criteria

- [ ] <ac_text> -- <evidence_type> -- <check_command>
- [ ] <ac_text> -- <evidence_type> -- <check_command>

## Out of Scope

<explicit non-goals>

## Dependencies

<planned task references, or "none">

## Verification

<how the implementation should be validated>
```

## Field Reference

| Field | Required | Purpose |
|---|---|---|
| `Title` | yes | Short imperative outcome |
| `PRD` | yes | Approved source and returned root backlog URL |
| `Context` | yes | Why the work exists |
| `Scope` | yes | Execution boundary and relevant change surface |
| `Acceptance Criteria` | yes | Observable completion conditions |
| `Out of Scope` | recommended | Prevent scope expansion |
| `Dependencies` | yes | Planned execution prerequisites |
| `Verification` | yes | Evidence required to establish completion |

## Acceptance Criteria

Each criterion should be:

- **Observable** — a reviewer can determine pass/fail.
- **Atomic** — one verifiable condition rather than several unrelated claims.
- **Bounded** — no vague statements such as "works correctly" or "code is clean".
- **Traceable** — derived from the PRD or directly necessary to verify an approved requirement.

Use one evidence type:

| Value | Use when |
|---|---|
| `test` | Automated unit, integration, or end-to-end test proves the behavior |
| `curl` | HTTP/API behavior can be verified directly |
| `log` | An authoritative runtime signal proves the result |
| `manual` | Human inspection is genuinely required |
| `none` | No reliable runtime signal exists; explain the verification limitation |

A `check_command` must be repository-supported, non-mutating, and exit 0 on success. Never fabricate a command merely to fill the field.

## Example

```markdown
# Add document permission inheritance

## PRD

docs/prd/document-permissions.md

## Context

Extend the existing document permission model so inherited permissions are
resolved consistently for child documents.

## Scope

Extend the existing permission evaluation path and its API/UI integration;
reuse the current permission model and test infrastructure where possible.

## Acceptance Criteria

- [ ] Child documents resolve inherited permissions from the parent -- test -- npm test -- permission-inheritance
- [ ] The API returns the effective permission for an inherited document -- curl -- curl -fsS "$BASE_URL/api/documents/$ID/permissions"

## Out of Scope

- Replacing the existing permission model
- Introducing a new authentication system

## Dependencies

permission-model

## Verification

Run the targeted permission tests and the API verification command.
```

## Anti-Patterns

- Do not use unchecked criteria as completed state (`- [x]`).
- Do not invent API contracts, endpoints, limits, or architecture absent from the PRD or repository evidence.
- Do not split a coherent vertical slice merely to produce more issues.
- Do not use file/layer names as the task's only scope definition.
- Do not make dependencies provider IDs during planning; use stable task references until AFK resolves them.
- Do not use mutating verification commands.

## Handoff to AFK

The agent supplies the reviewed task plan and body. Pass it through
`afk backlog create --description-file`, with `--parent` and repeated
`--depends-on` options. AFK creates provider records, assigns canonical IDs,
establishes supported relationships, returns concrete URLs, and adds a
`## Backlog Links` section with self, parent, and dependency URLs. Verify the
created records match the approved plan.
