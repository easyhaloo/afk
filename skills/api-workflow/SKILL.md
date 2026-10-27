---
name: api-workflow
description: >-
  Multi-step API testing with Playwright. Generates executable test files from
  codebase-grounded business scenarios, with optional browser verification and
  reusable authentication. Selects local CDP or storage-state based on the
  execution environment. Triggers: "test API workflow", "verify webhook",
  "trigger async job and poll for completion", "API then browser verify",
  "reuse browser login", "browser auth session".
---

# API Workflow Testing

**Tool:** Playwright | **Output:** `tests/api-workflow/` or an existing test directory

## References

| Type | Path |
|------|------|
| API patterns | `references/api-patterns/` |
| API + browser patterns | `references/hybrid-patterns/` |
| Auth modes | `references/hybrid-patterns/browser-auth-modes.md` |
| Templates | `scaffold/` |

## Process

### 1. Discover the target project

Inspect the repository before designing tests. Gather evidence for:

- Authentication middleware, credential types, and session storage.
- Login and logout flows, including SSO, MFA, OAuth, and passkeys.
- Route definitions, request schemas, response schemas, and error behavior.
- Async task triggers, status endpoints, terminal states, and authoritative results.
- Test-data creation, ownership, cleanup, and idempotency.
- Existing Playwright configuration, package manager, test directory, and CI environment.

Do not infer endpoints, payloads, status values, or selectors from examples. Record unknowns instead of guessing.

### 2. Select the authentication mode

Choose based on execution environment:

| Environment | Mode |
|-------------|------|
| Local development with a dedicated, already-authenticated Chromium session on loopback CDP | `localhost-cdp` |
| CI or another non-interactive environment where authentication can be scripted | `storage-state` |

Reject `localhost-cdp` in CI, for non-Chromium browsers, and for non-loopback endpoints. If the environment or auth flow cannot safely support either mode, stop and ask for a suitable test identity or an explicit alternative.

The auth scheme affects how setup is implemented, but does not by itself determine the mode.

### 3. Present the plan and confirm

Before writing files, summarize:

- Detected project layout and output location.
- Chosen auth mode and its prerequisites.
- Concrete workflow steps, including expected outcomes and failure paths.
- Test data and cleanup strategy.
- Which parts are supported by code evidence and which require user input.

Do not generate the final test project until the user confirms the plan.

### 4. Generate only the selected path

Copy only the selected mode's fixture and required configuration. Replace all illustrative endpoints, payloads, selectors, and auth logic with findings from the target project. Do not copy example business logic as if it were real.

Generated projects must not contain unused auth modes, secrets, or business-specific remnants from these templates. Never commit credentials or auth-state files.

### 5. Validate in layers

Run checks in this order where supported:

1. Structural validation of generated files and configuration.
2. Type checking or test discovery.
3. A minimal authentication/setup run.
4. The requested workflow tests.
5. Cleanup verification and a concise result report.

Report each check as passed, failed, or not run. A structural validator passing is not evidence that authentication or business behavior works. Do not claim end-to-end success when the target service or credentials are unavailable.

## Output Options

**A: Existing frontend/test project** — integrate under its established test directory and reuse its package manager and Playwright configuration where possible.

**B: Standalone project** — use `tests/api-workflow/` when no suitable test harness exists or the user requests isolation.

Avoid introducing a second Playwright installation or conflicting configuration when the target repository already has one.

## Auth Mode Artifacts

For browser-based workflows, include only the selected mode's artifacts:

| Artifact | Requirement |
|----------|-------------|
| `fixtures/browser-session.ts` | Selected mode fixture, renamed to the stable import path |
| `setup/auth-api.setup.ts` or `setup/auth-ui.setup.ts` | Only for storage-state mode, using the discovered login mechanism |
| `playwright/.auth/` | Runtime auth state; must be gitignored |
| `.env.example` | Variable names only; no real secrets |
| `browser-auth-runbook.md` | Setup, re-authentication, and security instructions |

The setup template contains placeholders and is not executable until the discovered login flow is implemented. Never save an empty or unauthenticated state file and report it as successful setup.

## Async Workflow Pattern

Discover the real trigger and polling endpoints from the application code. A common shape is:

```text
POST /action -> task identifier
GET /tasks/:id -> status
GET /tasks/:id/result -> authoritative result (if separate)
```

Poll only known non-terminal states; stop on success, known failure, or timeout. Include useful failure context without exposing credentials. Prefer the authoritative result over stale cached status when the application exposes one.

## Anti-patterns

- Guessing API paths, payloads, auth headers, status values, or selectors.
- Hardcoding credentials, API keys, or a real auth-state file.
- Using a personal browser profile or exposing CDP beyond loopback.
- Silently switching auth modes after a failure.
- Generating unused auth artifacts or carrying over domain-specific template code.
- Treating example scenarios or structural validation as proof of a working test.
