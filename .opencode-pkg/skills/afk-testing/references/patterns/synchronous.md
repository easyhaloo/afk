# Synchronous Request/Response Pattern

Use when an operation returns its business result within the same request or call.

## Inputs to discover

- Business rule and expected result;
- request/command schema and authentication requirements;
- documented transport status, business status/error code, response schema;
- expected persistence changes and external side effects.

## Assertions

Verify the appropriate combination of:
- transport-level status (for example, HTTP status);
- business-level code and stable response fields;
- response schema and required/forbidden fields;
- persisted state and meaningful side effects;
- authorization and tenant boundaries;
- idempotency for operations that promise it.

Do not conflate HTTP status, an application error code, and a persisted domain state. Derive each expected value from a rule or contract.

## Negative and boundary scenarios

Cover invalid/missing parameters, unsupported state transitions, unauthenticated and unauthorized requests, duplicate requests, conflict cases, and relevant limits. Select cases based on plausible risks rather than exhaustively crossing every input.

## Evidence

Record the request shape without secrets, actual status/result, relevant persisted state, and the test that asserts the behavior. Use the repository's native client and fixture helpers.
