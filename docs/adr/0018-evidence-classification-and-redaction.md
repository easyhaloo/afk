# ADR-0018: Evidence Classification and Redaction Before Persistence
## Status
Accepted
## Context
Agents read repository content, issue text, and environment data, and patches
can contain credentials, personal data, or proprietary code. Storing those
values indiscriminately in logs, metrics, or traces makes observability a
security liability. A run must still be explainable after the fact, which
means the audit trail has to keep the shape of the run without keeping the
payloads that may be sensitive.
## Decision
Audit events retain stable metadata and content hashes. Potentially large or
sensitive payloads are stored through an `EvidenceStorePort` and referenced by
immutable `EvidenceRef` values with classification and redaction status. Secrets
are redacted before event, log, metric, trace, or evidence persistence. Metric
labels remain low cardinality and never contain identifiers, paths, prompts, or
commands. A failed mandatory redaction/classification blocks automated external
side effects.

The three values of `EvidenceClassification` are `public`, `internal`, and
`sensitive`; the three values of `RedactionStatus` are `not_required`,
`applied`, and `restricted`. An `EvidenceRef` carries the evidence URI, its
SHA-256, its media type, and both values, so a reader can tell what was kept
without reopening the payload. The local store applies redaction to the
payload bytes before encryption and derives the final status from the result:
`applied` when redaction changed the bytes, otherwise the status it was given.
Redaction covers provider token formats, generic API key and secret
assignments, and bearer authorization headers.
## Consequences
The system can explain a run without exporting secrets or high-cardinality data.
Evidence requires retention, encryption, authorization, and secure retrieval
controls. Existing diagnostic capture must migrate to explicit classification.

Because classification travels with the reference rather than with the
payload, a consumer that ignores the reference never receives the sensitive
bytes. The cost is that a diagnostic which previously embedded its own payload
must now name the evidence and let the store own the bytes.

> **Reconstruction note.** The original text of this ADR was corrupted when it
> was first written: the `## Status` and `## Context` headings and the opening
> of the Context paragraph were replaced by a run of `## S## S##` fragments, and
> one line of the Decision paragraph was garbled. The surviving decisions were
> preserved verbatim; the missing sections were reconstructed from the
> implemented semantics in `packages/afk-core/src/events.ts`,
> `packages/afk-core/src/ports.ts`, and
> `packages/afk-execution/src/infrastructure/observability/local-evidence-store.ts`.
## References

- `packages/afk-core/src/events.ts` — `EvidenceClassification`, `RedactionStatus`, `EvidenceRef`
- `packages/afk-core/src/ports.ts` — `EvidenceStorePort` and the core port set
- `packages/afk-execution/src/infrastructure/observability/local-evidence-store.ts` — encrypted local store and `redactUtf8`
