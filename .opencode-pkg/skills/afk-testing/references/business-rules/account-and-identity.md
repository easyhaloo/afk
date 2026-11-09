# Account and Identity Rules

These natural-language rules are candidates for applications that maintain user
or service accounts. Apply only where the corresponding capability exists.

## Account lifecycle

### ACCOUNT-001 — Account identity is unambiguous
A login or account identity must resolve to no more than one account within the
scope the product defines. If the product requires uniqueness, attempts to
create a conflicting identity must not silently attach a new request to an
unintended existing account.

**Project decisions to confirm:** which identifiers are unique (username,
email, phone, external subject), whether uniqueness is global or tenant-scoped,
and whether case, whitespace, or Unicode normalization affects comparison.

**Test angles:** duplicate creation; concurrent attempts with the same identity;
normalization boundaries; uniqueness after account deletion or restoration.

### ACCOUNT-002 — Account creation follows the product's enrollment policy
An account can become usable only through an enrollment path the product
supports, such as self-registration, administrator provisioning, invitation,
or external identity federation. Required verification or approval steps must
not be bypassed through an alternate entry point.

**Project decisions to confirm:** allowed enrollment paths and whether email,
phone, domain, invitation, or administrator approval is required.

**Test angles:** missing or invalid invitation; expired invitation when supported;
unverified account access; duplicate invitation redemption.

### ACCOUNT-003 — Account status constrains account use
When the product defines statuses such as pending, active, suspended, locked, or
disabled, operations must respect those statuses. A status transition must not
accidentally leave the account usable through a path that should be protected by
the same restriction.

**Project decisions to confirm:** supported statuses, allowed transitions, and
which operations remain available while restricted.

**Test angles:** login and protected actions for each relevant status; direct API
access after suspension; legal and illegal transitions.

### ACCOUNT-004 — Credential recovery proves control of the recovery channel
When password or credential recovery is supported, a recovery operation must
require the product's approved proof of control and must not let an expired,
invalid, reused, or tampered recovery artifact authorize a new credential.

**Project decisions to confirm:** recovery channels, token lifetime, one-time-use
semantics, and notification behavior.

**Test angles:** invalid and expired tokens; token replay; concurrent redemption;
credential change after recovery.

### ACCOUNT-005 — Credential changes take effect consistently
A successful credential change must be reflected by subsequent authentication
attempts according to the product's credential policy. A failed change must not
leave a partially updated credential state.

**Project decisions to confirm:** whether a password change revokes existing
sessions, refresh tokens, API keys, or trusted devices.

**Test angles:** old versus new credential; failed persistence; session and token
revocation where required.

## Session and authentication lifecycle

### ACCOUNT-006 — Session termination is respected
When a user logs out, an administrator revokes access, or an account is
disabled, credentials or sessions that the product declares revoked must no
longer authorize protected actions. UI state alone is not proof of revocation.

**Project decisions to confirm:** access-token lifetime, refresh-token rotation,
server-side session storage, and revocation guarantees.

**Test angles:** old access and refresh tokens; logout followed by direct API
requests; revoked sessions across multiple clients.

### ACCOUNT-007 — Authentication responses do not disclose unnecessary secrets
Login and recovery responses must not expose passwords, reset tokens, session
secrets, or other authentication material. Where account enumeration is a
risk, response content and observable timing should follow the product's
security policy.

**Project decisions to confirm:** error-message policy and accepted timing
tolerance; do not assert perfect timing equality without an agreed method.

**Test angles:** success and failure responses; logs and error payloads; unknown
account versus wrong credential behavior.
