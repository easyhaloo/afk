# Browser Authentication Strategy

Select a browser authentication strategy from the application's auth model and the actual execution environment. The modes below are reusable implementation patterns, not a fixed decision tree.

## Strategy Selection

Inspect the repository and environment before choosing a strategy:

- How authentication is established: API login, UI login, SSO/OAuth, MFA, passkey, or another mechanism.
- Where auth state is stored: cookies, localStorage, sessionStorage, IndexedDB, or a browser-managed session.
- Where the test runs: local interactive session, headless local execution, or CI.
- Which browser engine is available.
- Whether the repository already provides fixtures, setup projects, or persisted state.

Prefer the repository's existing authentication infrastructure. Choose the least coupled strategy that reliably reproduces the required authenticated state.

If the required identity or authentication capability cannot be established safely, stop and request the missing information rather than inventing credentials or silently switching strategies.

## `storage-state`

Use persisted Playwright authentication state when authentication can be established by a setup flow and the resulting state can be safely reused by isolated test contexts. This is generally suitable for non-interactive and CI execution.

Authentication may be established through an existing API or UI setup. Persist only the state required by the application and configure dependent tests to load it through the repository's Playwright setup.

Important considerations:

- `storageState` does not include `sessionStorage`; applications relying on it require explicit export and restoration.
- IndexedDB state requires the Playwright capability supported by the repository version.
- Authentication state is credential material. Store it in the repository's ignored auth-state location or an equivalent secure location and regenerate it when expired.
- Reuse existing setup projects and fixtures rather than generating parallel authentication infrastructure.

## `localhost-cdp`

Use CDP only when an intentionally launched, already-authenticated Chromium session is part of the local execution contract and the test must reuse that live session.

Requirements:

- Chromium with a dedicated non-default user-data directory.
- A loopback CDP endpoint such as `localhost`, `127.0.0.1`, or `[::1]`.
- An existing authenticated browser session.
- Local execution; this strategy is not suitable for CI.

The fixture must connect without taking ownership of the external browser's pre-existing pages. Close only test-owned pages and the Playwright connection during teardown.

Security constraints:

- Never expose the CDP endpoint beyond loopback.
- Never commit or log the endpoint as a credential.
- Never point remote debugging at a user's normal personal Chrome profile.
- CDP reuses an existing valid session; it does not bypass authentication or MFA.

## State Sensitivity

Treat all authentication artifacts as credentials:

| Artifact | Handling |
|---|---|
| Playwright storage state | Store in an ignored auth directory; never commit |
| CDP endpoint | Environment-only; loopback only |
| Persistent browser profile | Keep outside the repository |

Generated projects should use the repository's existing secret and ignore-file conventions.

## Verification

Before relying on an authentication strategy, verify that the resulting test identity can access the API and browser state required by the workflow. Authentication success alone is insufficient if the identity lacks the required authorization or tenant/data scope.

When authentication fails, distinguish between missing credentials, expired state, unsupported auth flow, and application authorization failure before changing the strategy.