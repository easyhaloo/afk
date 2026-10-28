# Identity, Authorization, Tenancy, and Security Patterns

Load when behavior depends on identity, roles, ownership, quotas, trust boundaries, secrets, or untrusted data.

## Account and identity lifecycle

Use synthetic accounts and project-owned account factories. Cover create/activate/disable/lock/expire/delete flows, session/token expiry and refresh, password reset or identity-provider failure when applicable. Never use production accounts or real personal data for automated tests.

## Authentication vs authorization

Test each separately. Authentication tests identity proof and invalid/expired credentials. Authorization tests whether an authenticated principal can perform an action on a resource. Include positive and negative cases for roles, permissions, ownership, resource scope, and cross-tenant access.

## Multi-tenant isolation

Vary tenant and principal independently. Verify reads, writes, searches, caches, files, background jobs, events, callbacks, and logs cannot cross tenant boundaries. Include identifier substitution and queued work executed after the caller's session has ended when relevant.

## Status codes, error mapping, and information leakage

Assert the documented protocol status, application error code, and safe error detail independently. Check that unauthorized requests do not leak resource existence or sensitive data when the contract requires concealment. Ensure logs and reports redact secrets, tokens, personal data, and file contents.

## Input and file safety

Validate untrusted paths, filenames, content types, size limits, archive expansion, parser errors, and stored object access. Use synthetic malicious fixtures safely in isolated tests. Avoid executing uploaded content or testing destructive payloads against shared environments.

## Resource quotas and abuse controls

Test rate/size/concurrency quotas per principal or tenant, boundary behavior, recovery when the quota window resets, and the correct treatment of privileged or exempt users.

## Sources

- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
- Azure Throttling pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling
