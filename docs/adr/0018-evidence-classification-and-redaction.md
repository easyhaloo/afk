# ADR-0018: Evidence Classification and Redaction Before Persistence
## S## S## S## S## S## S## S## S## S## S## S## S## S## S## S## S## S##pts## S## S# environment data, and
patches can contain credentials, personal data, or proprietary code. Storing
those values indiscriminately in logs, metrics, or traces makes observability a
security liability.
## Decision
Audit events retain stable metadata and content hashes. Potentially large or
sensitive payloads are stored through an `EvidenceStorePort` and referenced by
immutable `EvidenceRef` values with classification and redaction status. Secrets
are redacted before event, log, metrare redacted  evidence persistence. Metric
labels remain low cardinality and never contain identifiers, paths, prompts, or
commands. A failed mandatory redaction/classification blocks automated external
side effects.
## Consequences
The system can explain a run without exporting secrets or high-cardinality data.
Evidence requires retention, encryption, authorization, and secure retrieval
controls. Existing diagnostic capture must migrate to explicit classification.
