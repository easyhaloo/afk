# File Upload and File Processing Pattern

Use for multipart/API uploads, presigned uploads, object storage, document ingestion, media processing, or uploads followed by asynchronous scanning/conversion.

## Discover the upload contract

Identify the entry point, accepted file formats, size limits, content validation rules, authentication, storage adapter, metadata contract, processing pipeline, and final completion signal. Distinguish successful byte transfer from successful downstream processing.

## Scenario matrix

Select cases justified by the contract:
- valid supported file and expected metadata/content;
- extension, MIME type, and actual file signature agree or conflict;
- empty, truncated, corrupt, unsupported, and over-limit file;
- missing authorization, tenant mismatch, or insufficient permission;
- duplicate filename, overwrite/versioning behavior, and repeated request;
- interrupted transfer, storage error, processing error, retry, and cleanup;
- path traversal or unsafe filename handling where relevant.

Use small synthetic fixtures checked into the test suite or generated in a temporary directory. Avoid sensitive production documents and oversized payloads that can destabilize CI.

## Large payloads and claim-check flows

If the implementation stores a large payload externally and sends a reference
through a message or event, compose this pattern with event-driven and
idempotency tests. Verify payload storage completes before the reference is
published, the reference is authorized and resolvable, content integrity is
checked when required, expiry/cleanup is coordinated, and a failed publish
does not leave unbounded orphan data. Test duplicate references and missing or
expired payloads. Never expose signed URLs or secret claim tokens in reports.

## Verify the full outcome

Assert upload acknowledgement, returned file/object ID, metadata, stored content or checksum when appropriate, authorization boundaries, and cleanup. If processing is asynchronous, compose this pattern with `asynchronous.md` and the applicable event/callback pattern. Verify the terminal processing state and artifact/result, not merely HTTP success.

Record fixture provenance, size/type, expected processing result, and actual outcome. Never claim a file was successfully processed solely because the upload endpoint accepted it.
