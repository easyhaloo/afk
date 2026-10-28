# Common Business Rule Library

This library contains reusable, natural-language business-rule candidates for
software products that share common company capabilities. It helps
`afk-testing` discover requirements and test scenarios; it is not a
machine-enforced policy file or a default specification for every project.

## Rule packs

| Pack | Covers | Reference |
|---|---|---|
| Account and identity | Account lifecycle, identity uniqueness, credential recovery, sessions | [account-and-identity.md](account-and-identity.md) |
| Authorization and tenancy | Authentication, permissions, resource ownership, tenant isolation | [authorization-and-tenancy.md](authorization-and-tenancy.md) |
| File upload and download | Validation, storage lifecycle, permissions, links, deletion and cleanup | [file-upload-download.md](file-upload-download.md) |
| Data and API lifecycle | Data integrity, updates, delete semantics, pagination, batch operations | [data-and-api-lifecycle.md](data-and-api-lifecycle.md) |
| Async tasks and notifications | Background jobs, duplicate delivery, retries, cancellation, recipients | [async-tasks-and-notifications.md](async-tasks-and-notifications.md) |
| Audit and sensitive data | Accountability, secret/PII handling, retention and log access | [audit-and-sensitive-data.md](audit-and-sensitive-data.md) |

## How to use the library

1. Inspect project requirements and existing business documents first. Follow the
   repository's conventions; do not require business owners to rewrite PRDs,
   tickets, or prose as structured configuration.
2. Select only packs relevant to capabilities present in the project. A project
   without accounts, uploads, background jobs, or multi-tenancy must not receive
   tests for those capabilities merely because a pack exists.
3. Read the rules as natural language. Derive a test scenario, candidate data,
   and observable assertions from each applicable rule. Internal structured
   notes are allowed, but YAML/JSON is not required as the rule-authoring format.
4. Record each selected rule's ID and source in the test plan or working notes.
   Distinguish built-in candidates from project-authoritative requirements.
5. Reuse existing factories, fixtures, test seeds, and adapters. Generate
   deterministic synthetic data only where existing helpers do not suffice.
6. Report rules as confirmed, observed, assumed, unresolved, or not applicable.
   Do not report a candidate as covered until a test with a meaningful oracle
   has actually executed.

## Rule authority

- **Project-authoritative rule:** explicitly stated in an approved requirement,
  project document, contract, or a decision confirmed by the responsible owner.
  This is the source of expected business behavior.
- **Common security baseline:** a candidate protection expectation to evaluate
  wherever the corresponding protected resource or sensitive operation exists.
  Verify the actual resource boundary and observable outcome; do not infer that
  a feature exists just because it appears in a rule pack.
- **Policy-dependent rule:** a behavior that varies by organization or product,
  such as whether a login identifier is case-sensitive, whether accounts need
  email verification, permitted file types and sizes, retention periods, or
  soft-delete semantics. Keep it unresolved until project evidence confirms it.
- **Observed behavior:** behavior found in code or current tests but not yet
  established as the intended requirement. It may guide characterization tests,
  but must not silently become the specification.

When sources conflict or a missing decision changes an assertion, report the
question and continue with independent tests where possible. Do not block all
testing because one rule is unresolved, and do not invent an answer just to
produce executable tests.

## Rule format

These Markdown packs are the source format. Rules use stable IDs for traceability
and free-form prose for the actual business statement. The headings and
verification notes help the Agent reason consistently; they are not a required
template that business owners must follow.

Each rule may include applicability, business meaning, example test angles,
and decisions that require confirmation. Do not mechanically convert every
suggested test angle into a test. Choose cases based on risk, evidence, project
architecture, and existing coverage.

## Keeping the library healthy

Add a rule when it describes a reusable company-level behavior across multiple
projects. Keep organization-specific values and decisions in the project-owned
rule source. Avoid duplicates with the pattern catalog: rule packs say **what
behavior may be required**; pattern packs say **how to test a class of behavior**.
