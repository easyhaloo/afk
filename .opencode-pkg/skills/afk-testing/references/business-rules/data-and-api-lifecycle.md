# Data and API Lifecycle Rules

Use these candidates for APIs and services that create, query, update, delete,
or process business records. Match each rule to the application's actual
contracts and persistence model.

## Record integrity and mutation

### DATA-001 — A successful mutation is reflected consistently
When a create or update operation reports success, subsequent reads and
dependent operations must observe the result according to the product's
consistency contract. If a mutation fails, it must not leave an invalid partial
business state.

**Test angles:** read-after-write; transaction rollback; downstream effects;
failure after partial persistence; cache and search-index propagation.

### DATA-002 — Invalid references cannot corrupt related records
A request that references a missing, unauthorized, or incompatible related
record must follow the declared validation/error behavior and must not create
an unintended relationship or partial record.

**Test angles:** nonexistent parent ID; cross-tenant reference; deleted parent;
wrong record type; race between validation and mutation.

### DATA-003 — Concurrent updates follow the declared conflict policy
When multiple callers modify the same record, the resulting state must follow
the product's concurrency contract. The system must not silently lose updates
where the contract promises conflict detection or atomic modification.

**Project decisions to confirm:** optimistic version checks, last-write-wins,
merge behavior, locking, and conflict responses.

**Test angles:** overlapping updates; stale version; repeated form submission;
retry after timeout; simultaneous delete and update.

### DATA-004 — Delete behavior is explicit and consistent
Deletion must follow the product's declared soft-delete, hard-delete, archive,
or retention semantics. A deleted record must not remain accessible through
ordinary read paths contrary to that policy, and related records must not be
left in an invalid state.

**Project decisions to confirm:** restore behavior, cascades, historical access,
foreign-key policy, retention, and audit requirements.

**Test angles:** reads after deletion; list/search after deletion; restore; related
records; retries of delete requests.

### DATA-005 — Repeated requests do not repeat protected effects where idempotency is promised
When an operation is declared idempotent or accepts an idempotency key, retries
of the same logical request must not duplicate protected effects. Requests that
are not equivalent must not be incorrectly collapsed into one result.

**Test angles:** same key and same payload; same key with different payload;
timeout after commit and retry; concurrent duplicate requests.

## Read and list behavior

### DATA-006 — Query boundaries and pagination are honored
List, filter, sort, and pagination APIs must honor their declared limits and
query semantics. A page boundary must not silently duplicate or omit records
when the API promises a stable snapshot or cursor behavior.

**Project decisions to confirm:** maximum page size, ordering guarantees, cursor
semantics, and consistency while records change.

**Test angles:** zero/minimum/maximum limits; empty result; invalid cursor;
duplicate sort keys; inserts or deletes between page requests.

### DATA-007 — Queries apply the same access and tenant scope as direct reads
List, search, count, aggregation, export, and batch operations must apply the
same authorization and tenant constraints as direct resource access.

**Test angles:** compare direct read with list/search/export; counts that might
reveal foreign records; filters using another tenant's ID.

### DATA-008 — Bulk operations report partial outcomes accurately
When a batch contains multiple records, the result must follow the product's
declared atomicity policy. A partial failure must not be reported as complete
success, and successful and failed items must be distinguishable where the
contract allows partial completion.

**Project decisions to confirm:** all-or-nothing versus per-item results,
rollback guarantees, retry semantics, and batch-size limits.

**Test angles:** all-valid batch; one invalid item; duplicate item; timeout midway;
retry after partial completion.
