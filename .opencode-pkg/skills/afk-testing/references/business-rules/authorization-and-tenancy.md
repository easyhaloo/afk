# Authorization and Tenant Isolation Rules

Use these rules when the product protects resources, exposes multiple roles, or
serves multiple tenants, organizations, workspaces, or customers.

## Access control

### AUTHZ-001 — Protected resources require an authenticated principal
Operations that are defined as protected must not grant access merely because
the caller knows a resource identifier or endpoint. A missing, invalid, or
expired identity credential must not authorize a protected read or mutation.

**Project decisions to confirm:** which routes and resources are public, optional,
or protected, including service-to-service and signed-link exceptions.

**Test angles:** anonymous request; invalid and expired token; direct endpoint
access without navigating through the UI.

### AUTHZ-002 — Permission is checked for the requested action and resource
A user may perform an operation only when their effective permissions allow
that action on that resource. Hiding a button or menu is not an authorization
control; the operation itself must enforce access.

**Project decisions to confirm:** roles, resource ownership, scopes, permission
inheritance, delegated access, and any explicit administrative override.

**Test angles:** read versus write; own versus another user's resource; role with
read-only permission; direct API call bypassing frontend restrictions.

### AUTHZ-003 — Access is denied when no applicable grant exists
A protected operation must not become allowed merely because a permission rule
is missing, malformed, or cannot be resolved. The product's explicit public
access rules remain valid exceptions.

**Project decisions to confirm:** default-deny architecture and documented
public-resource exceptions.

**Test angles:** unknown role; missing policy entry; malformed claims; stale or
incomplete permission data.

## Tenant and ownership boundaries

### AUTHZ-004 — Tenant-scoped data stays within its tenant boundary
When a resource belongs to a tenant, organization, or workspace, a caller from
another tenant must not read or mutate it unless an explicit, validated
cross-tenant permission exists. Filtering only in the frontend is insufficient.

**Project decisions to confirm:** tenant membership model, cross-tenant support
roles, shared/global resources, and tenant migration behavior.

**Test angles:** read, update, delete, search, export, download, and background
processing across two synthetic tenants; change tenant identifiers in request
payloads; verify both response and persisted effects.

### AUTHZ-005 — Resource identifiers do not substitute for authorization
Possession or guessing of an object ID, file ID, job ID, or URL must not
silently grant access. Each access path must apply the relevant ownership,
scope, or capability check.

**Test angles:** substitute another user's ID; enumerate sequential IDs; access
the same resource through API, download, and asynchronous task-status routes.

### AUTHZ-006 — Permission changes are reflected according to the revocation policy
After a grant is removed, a role is downgraded, or tenant membership ends,
subsequent protected operations must follow the product's declared revocation
semantics. Cached permissions or long-lived tokens must not exceed the agreed
policy.

**Project decisions to confirm:** immediate versus bounded-delay revocation,
token refresh rules, cache invalidation, and treatment of in-flight operations.

**Test angles:** permission removal then read/write; stale token; cached session;
re-added membership and restoration behavior.

### AUTHZ-007 — Lists, counts, searches, and derived views respect access scope
Resource lists, aggregate counts, autocomplete, search results, exports,
notifications, and cached or materialized views must not reveal protected
records outside the caller's scope.

**Test angles:** compare list and total counts across tenants; search by a known
foreign identifier; test cached results after switching identity or tenant.
