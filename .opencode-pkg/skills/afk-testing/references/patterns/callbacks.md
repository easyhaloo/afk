# Callback and Webhook Pattern

Use when the system sends a callback to a consumer or receives a webhook from an external system.

## Identify direction

For an inbound webhook, the application is the receiver. For an outbound callback, the application is the sender and the test owns a controlled receiver. Do not confuse callback initiation with successful processing.

## Assertions

Cover the documented contract:
- request method/path, payload schema, stable identifiers and correlation;
- signature/authentication verification and timestamp/replay protections where required;
- acknowledgement status and resulting state change;
- timeout, retry/backoff, duplicate delivery, idempotency, and out-of-order delivery where specified;
- rejection of invalid signatures or malformed payloads;
- redaction of credentials and sensitive payload fields from logs and reports.

Use a local fake receiver/server for outbound callbacks and project-provided webhook fixtures for inbound calls. Keep tests independent of public callback endpoints unless the test is an explicitly opted-in external integration test.

## Evidence

Record the sanitized callback request/response, delivery attempt count, relevant state, and whether the callback was received and processed. Bound retries and wait times; never let a callback test hang indefinitely.
