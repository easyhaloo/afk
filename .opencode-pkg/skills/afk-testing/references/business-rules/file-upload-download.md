# File Upload and Download Rules

Use these rules when a product accepts, stores, processes, previews, shares, or
serves files. The file pattern catalog describes interaction and processing
patterns; this pack describes candidate business and security expectations.

## Upload and storage

### FILE-001 — Upload validation follows the declared file policy
An upload must be accepted or rejected according to the product's explicit
file policy. Validation must not rely on a filename extension alone when the
product requires checks of actual content or format.

**Project decisions to confirm:** maximum size, allowed and forbidden formats,
empty-file behavior, MIME/content sniffing policy, archive handling, malware
scanning, and user-facing error semantics.

**Test angles:** allowed and disallowed formats; extension/content mismatch;
boundary file sizes; empty and malformed files; misleading filenames.

### FILE-002 — An incomplete or rejected upload is not exposed as a completed file
If an upload fails, is cancelled, or does not complete required processing, the
system must not represent it as a successfully available file. Partial storage
must be cleaned up or retained only according to an explicit recovery policy.

**Test angles:** interrupted stream; storage failure; validation failure after
temporary storage; worker failure; retry and cleanup.

### FILE-003 — Upload ownership and destination permissions are enforced
A caller may upload only to a destination they are permitted to modify. A
client-supplied owner, tenant, directory, or destination identifier must not
override server-verified permissions.

**Test angles:** unauthorized destination; altered owner/tenant ID; destination
removed during upload; upload into another user's or tenant's directory.

### FILE-004 — File identity and naming do not cause unintended overwrite
If names can collide, the product must apply its declared conflict policy
(rename, reject, version, or replace). A collision must not silently destroy
another file unless replacement is explicit and authorized.

**Project decisions to confirm:** conflict policy, case sensitivity, Unicode
normalization, duplicate-content handling, and versioning behavior.

**Test angles:** same name in same folder; same name across folders/tenants;
concurrent uploads; path and Unicode normalization.

## Download and sharing

### FILE-005 — Download permission is checked at the access boundary
A caller must be permitted to read or download the requested file at the point
where the stored content or a usable download capability is issued. A file ID,
storage path, cached response, or unprotected API must not bypass the policy.

**Test angles:** own versus foreign file; revoked access; direct object-storage
or API URL; preview, thumbnail, range request, and export paths where supported.

### FILE-006 — Temporary download capabilities follow their declared scope
When the product uses expiring or signed links, their lifetime and permitted
resource/action must follow the declared policy. A revoked or expired link must
not continue granting access beyond the product's stated guarantees.

**Project decisions to confirm:** expiry, one-time use, IP/device binding, revocation,
and whether links can be forwarded.

**Test angles:** expired link; altered resource reference; access after revocation;
link for one file used against another file.

### FILE-007 — File paths and names cannot escape the permitted storage boundary
User-controlled names, paths, archive entries, and destination fields must not
allow access to or writes outside the permitted storage area. Display names
must remain separate from trusted storage paths where the design requires it.

**Test angles:** traversal sequences; absolute paths; encoded separators; archive
entries with parent segments; Unicode and normalization edge cases.

### FILE-008 — Delete and retention behavior stays consistent
Deleting a file must follow the product's declared authorization and lifecycle
policy. The file must not remain downloadable through an unprotected alternate
path after deletion takes effect. Where versions, references, legal holds, or
retention periods exist, deletion must respect them.

**Project decisions to confirm:** soft versus hard delete, recovery window,
shared-file references, retention policy, and behavior while processing.

**Test angles:** access after deletion; recycle-bin restore; shared references;
cleanup of metadata and blobs; retention and legal-hold exceptions.

### FILE-009 — File processing status matches observable availability
When upload triggers asynchronous scanning, conversion, preview generation,
or indexing, the file's reported status must not imply that unavailable or
unapproved content is ready for use. Completion should be observable through
the product's declared status or event contract.

**Test angles:** processing and failed states; status/result consistency; duplicate
worker delivery; retry; download before and after readiness.
