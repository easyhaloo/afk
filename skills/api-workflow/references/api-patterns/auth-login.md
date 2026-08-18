# Authentication

Authentication is an application-specific workflow. Discover the real authentication contract before generating requests or browser state.

## Determine

Inspect the application and existing test infrastructure to establish:

- authentication entry point and protocol
- required credentials or test identity
- tokens, cookies, headers, or other session state returned
- authorization scope, tenant, and identity requirements
- refresh or expiry behavior
- repository-supported fixtures or setup projects

Do not assume `/auth/login`, a `token` field, `userId`, Bearer authentication, or API-key headers unless the target application proves them.

## API Authentication

When the application authenticates through an API:

1. Call the discovered authentication endpoint with the required payload.
2. Verify the authentication response and extract only the state required by subsequent requests.
3. Apply that state using the application's actual mechanism.
4. Verify authorization against the intended identity and scope before testing the workflow.

Reuse an existing repository auth helper when available.

## Browser Authentication

When authentication is browser-session based, use the strategy selected from the application's auth model and execution environment. See `hybrid-patterns/browser-auth-modes.md` for implementation options.

## Principle

Authentication references describe the reasoning and invariants; endpoint paths, payloads, field names, and credentials must come from the target application.