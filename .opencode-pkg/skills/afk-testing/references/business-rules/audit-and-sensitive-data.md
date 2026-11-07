# Audit and Sensitive Data Rules

Use these candidates wherever a product changes sensitive business state,
handles personal information, or records security-relevant operations.

## Audit and accountability

### AUDIT-001 — Important actions can be traced to their actor and outcome
For operations that the product designates auditable, records should provide
enough trustworthy context to determine who or what initiated the action, the
target, the time, and the outcome. The recorded actor must come from verified
identity context rather than an untrusted caller-supplied label.

**Project decisions to confirm:** which actions are auditable, required fields,
eventual consistency, retention, and whether before/after values are permitted.

**Test angles:** successful and rejected sensitive actions; actor spoofing;
missing correlation ID; audit write failure; timestamp and target correctness.

### AUDIT-002 — Audit records cannot be altered by unauthorized actors
Users must not be able to forge, edit, or delete audit records through ordinary
business APIs unless the product explicitly provides an authorized retention
or administration process with its own controls.

**Test angles:** direct API mutation; tenant boundary; audit export permissions;
administrative access and its own trail where applicable.

## Sensitive data

### DATASEC-001 — Secrets are not exposed through ordinary outputs
Passwords, tokens, private keys, session secrets, and other credentials must
not appear in ordinary API responses, application logs, traces, exception
messages, or test reports. Authorized secret-retrieval flows are explicit
exceptions and must be tested against their own access policy.

**Test angles:** success/error logs; serialization; tracing attributes; stack
traces; assertion failure output; debug and support endpoints.

### DATASEC-002 — Personal and confidential data is exposed only for a defined purpose
A user, tenant, service, or support role should receive only the sensitive data
allowed by the product's access policy and the specific operation. Masking in
the UI alone does not protect a response payload, export, log, or background
artifact that contains the original value.

**Project decisions to confirm:** data classifications, field-level access,
masking policy, export restrictions, and support/admin exceptions.

**Test angles:** API and UI outputs; exports; search and logs; cross-tenant data;
notification previews; generated files.

### DATASEC-003 — Retention and deletion follow the declared data policy
Sensitive records and derived copies should be retained and deleted according
to the product's approved policy, including backups, exports, caches, and
asynchronous artifacts where covered by that policy.

**Project decisions to confirm:** retention windows, legal holds, backup expiry,
audit retention, recovery windows, and deletion propagation guarantees.

**Test angles:** expiry boundary; deleted record in cache/search/export; stale
download link; cleanup failure; legal-hold exception.

### DATASEC-004 — Test data does not introduce uncontrolled production exposure
Tests should prefer deterministic synthetic identities and records. Production
data may be used only through an approved, appropriately protected process,
including required anonymization or masking. Test reports and artifacts must
not accidentally preserve credentials or unnecessary personal data.

**Test angles:** seeded data source; fixture content; artifact upload; logs;
failure screenshots; retained workspace cleanup.
