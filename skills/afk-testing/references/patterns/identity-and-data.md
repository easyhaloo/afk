# Test Identity and Data Construction

Use when tests need accounts, credentials, roles, tenants, business entities, or related data setup.

## Discover existing construction mechanisms

Inspect the project's test fixtures, factories, builders, seed scripts, API helpers, and cleanup hooks before adding new helpers. Prefer supported APIs and repository-owned test factories over direct database mutation. If direct storage setup is necessary for a lower-level test, keep it behind a test helper and validate that it respects required invariants.

## Identity scenarios

Model only the identity dimensions required by the business rule, such as:
- authenticated vs. anonymous;
- role/permission;
- tenant or account ownership;
- active, disabled, locked, or expired state;
- owner vs. non-owner access.

Use unique, deterministic test identities and synthetic data. Never depend on production accounts, real personal data, shared mutable accounts, or committed credentials. Verify authorization and isolation with positive and negative cases.

## Data lifecycle

Make setup explicit and local to the test. Ensure each scenario knows which data it created and can clean it up safely. Avoid order-dependent tests and global fixtures that silently share state. For async operations, retain correlation IDs and clean up background work as well as the original records.

## Extending project support

Put reusable account builders and data factories in the project's existing test-support structure. Document their path and contract in the project testing profile. Do not generate a competing factory layer when an equivalent already exists.
