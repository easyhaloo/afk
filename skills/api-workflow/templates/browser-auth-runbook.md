# Browser Authentication Runbook

Authentication strategy must be selected from the target application's auth model, execution environment, and existing test infrastructure. This document describes implementation options; it does not prescribe one mode for local or CI execution.

## Select a Strategy

Establish first:

- whether authentication is API-, browser-, token-, cookie-, or certificate-based
- whether the environment is interactive
- whether the repository already provides an auth fixture or setup project
- whether session state can be safely persisted
- whether the test identity and authorization scope are suitable

Prefer the existing repository-supported mechanism. Do not create a second authentication system unless the existing one cannot support the workflow.

## CDP Session

Use a dedicated local Chromium session only when interactive authentication is required and CDP is an appropriate repository-supported strategy.

A safe setup should:

1. Use a dedicated browser profile, never a personal profile.
2. Bind the debugging endpoint to loopback.
3. Keep the profile and endpoint out of version control.
4. Authenticate manually in the dedicated session.
5. Reuse the session only for tests that require it.

The exact browser command, profile location, and endpoint must follow the target environment.

## Storage State

Use Playwright `storageState` when the repository and execution environment support scripted session reuse.

A setup project should:

1. Perform the application's real authentication flow.
2. Verify that authentication succeeded and the expected identity/scope is active.
3. Persist the resulting state to a gitignored location.
4. Load that state only for tests that require it.

The login endpoint, UI selectors, credential variable names, and state path must come from the target repository.

## Security

- Never commit credentials, auth state, browser profiles, or debugging endpoints.
- Use dedicated test identities with the minimum required permissions.
- Do not expose CDP beyond loopback.
- Do not weaken MFA or authorization controls to make tests pass.
- Do not upload reusable credentials or auth state as unprotected artifacts.

## Verification

Authentication is complete only when the test can establish the intended identity, authorization scope, and access to the required application state. A successful login response alone is insufficient.