# Runtime learning and validation implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement the independent tasks below. Existing user authorization covers implementation and validation; no intermediate confirmation is required.

**Goal:** Deliver a runnable plugin system that governs agent sessions, supplies bounded context, preserves evidence, and reuses verified experience on later relevant tasks.

**Architecture:** Keep execution authority, identity, budgets, verification gates and publication policy in the kernel. Reuse the existing plugin registry, workflow dispatcher, session stores and SQLite storage. Plugins supply agents, execution environments, context, knowledge retrieval, verification and evidence transports; experience never changes authority or automatically executes instructions.

**Tech stack:** TypeScript, Node SQLite, existing Zod validation, Vitest, built CLI subprocesses and local HTTP/command fixtures.

## Current evidence and gaps

| Area | Existing implementation | Work required |
| --- | --- | --- |
| Context | Code/retrieval/knowledge-base/project-memory providers; lifecycle composition | Connect configured sources to actual execution with provenance, size limits and per-project isolation |
| Execution | Typed workflow plans, leases, cleanup, interruption, token/handoff/time budgets | Exercise the same path across plugins, retries and independent verification |
| Templates | YAML validation/compiler and plugin template registration | Ensure registered plugin templates can actually be selected by the engine |
| Hooks | Ordered init/before-agent/after-agent/before-publish/cleanup | Verify required hooks block execution/publication and cleanup runs in reverse |
| Sessions | Native snapshots, checksums, Markdown fallback, usage aggregation, ownership | Validate recovery, corrupt sessions, cross-generation budgets and repeated failures |
| Experience | Structured failure diagnostics and retrospective reports | Durable candidate/verified/revoked experience, bounded retrieval and actual prompt use |
| Knowledge | Local files and HTTP fragment retrieval | Distinguish knowledge retrieval from evidence-based learning; prevent cross-project contamination |
| Coverage | Tests and a root reporter configuration | Measure source coverage, report missing coverage and establish an honest CI gate |

## System flow

```mermaid
flowchart TD
    Entry[CLI / Desktop / Trigger] --> Kernel[Identity / leases / authorization / workflow engine]
    Kernel --> Templates[Validated builtin / user / plugin templates]
    Kernel --> Context[Context policy: scope / relevance / budget / provenance]
    Context --> Sources[Context and knowledge plugins]
    Context --> Recall[Verified experience retrieval]
    Context --> Agent[Agent plugin + sandbox plugin]
    Agent --> Session[Session snapshots / usage / cancellation / handoff]
    Session --> Verify[Independent verification + policy gates]
    Verify --> Evidence[Tests / coverage / artifacts / run events]
    Evidence --> Candidate[Experience candidates with evidence]
    Candidate --> Review[Verify correction or revoke]
    Review --> Recall
    Verify --> Publish[Publish change request; human merge gate]
    Evidence --> Observe[Local audit + observability exporters]
```

## Contracts and lifecycle

- Context remains `gather({scope, prompt, limit}, options) -> ContextFragment[]`. Source material is untrusted data. A context file carries source references; the execution prompt carries a bounded reference to it. Source errors are visible and cannot silently become authoritative instructions.
- Workflow templates use the existing validated workflow schema and typed system/agent steps. Explicit file selection takes precedence over named templates. Plugin removal removes its templates; a missing selection fails before agent launch.
- Hooks use the existing five phases. Required before-agent/before-publish failures stop the corresponding operation. Cleanup is reverse ordered and best effort. A hook cannot replace a lease, verification or human merge gate.
- Experience records contain `id`, `fingerprint`, `scope`, `status`, `trigger`, `rootCause`, `action`, `evidence`, source run/work item, timestamps, expiration and occurrence count. States are `candidate -> verified -> revoked`; candidates are never injected as trusted advice. Verification requires additional evidence and a run reference. The original failure is never deleted by promotion.
- Verification follows the actual managed lifecycle: independent QA must start and pass, then either finish successfully or publish a confirmed change at its matching human merge gate. Later failure disqualifies the run. Original failure fingerprints and bounded verification history survive corrections and recurrence; saturation still withdraws advice.
- Experience storage exposes `recordFailure`, `list`, `recall`, `verify`, `revoke`, `close`. Recall returns only relevant, unexpired verified entries from the exact project scope and respects count/character budgets. Duplicate failures increase occurrences instead of creating unbounded copies.
- Agent sessions retain provider-native identifiers separately from AFK run/work-item identity. Existing token, time and handoff limits remain authoritative across recovery; resume cannot reset them. Experience is advice, not a mechanism for raising budgets or bypassing checks.
- Reports identify real execution, local service/command simulation and unconfigured external services separately. Test counts never stand in for source line/branch coverage.

## Implementation sequence

### 1. Plugin matrix (independent workers)

- [x] Add built CLI tests in `tests/e2e/plugin-local-matrix.test.ts`, `tests/e2e/plugin-http-matrix.test.ts`, and `tests/e2e/plugin-execution-matrix.test.ts`.
- [x] Assert resulting files, HTTP requests, process arguments and lifecycle transitions; include disabled providers, invalid inputs, denied policies and failed operations.
- [x] Run `pnpm exec vitest run tests/e2e/plugin-*-matrix.test.ts --no-file-parallelism`; all tests must pass without personal secrets, external messages or personal Keychain writes.

### 2. Evidence-based experience (independent worker, then engine integration)

- [x] Add `packages/runtime/src/application/learning/experience-store.ts` using `openSqlite` and transactions; add focused real-file tests alongside it.
- [x] Reject missing evidence, invalid dates, oversized fields and cross-scope retrieval; test duplicate recording, reopen, verification, revocation, expiration and bounded retrieval.
- [x] Integrate candidate recording with structured runner failures and verified retrieval with actual agent context assembly. A green run alone does not prove the recorded proposed correction: promotion remains an explicit evidence-bearing operation.
- [x] Expose local list/recall/verify/revoke operations through the existing CLI command registration pattern, with JSON output and project scope. Update the command registry documentation and CLI version.

### 3. Context, templates and session governance

- [x] Reuse existing `ContextSource`, `TemplateLoader`, `PluginRuntime`, `SessionStoreChain`, `BudgetManager`, failure diagnostics and lifecycle dispatcher.
- [x] Connect plugin template selection and bounded context to both initial and subsequent execution rounds; preserve source attribution and prompt budgets.
- [x] Add a workflow integration test proving verified experience reaches the next agent while candidate/revoked/expired/other-project records do not.
- [x] Verify corrupt snapshot fallback, persistent usage budgets, interruption cleanup, required hook denial, and repeated failure termination without a retry-budget reset.

### 4. Measured coverage (independent worker)

- [x] Add an explicit coverage command/config with the matching Vitest V8 provider and JSON summary/LCOV/HTML output.
- [x] Include untested source files and report package scope. Desktop has its own toolchain and must not be represented as covered by the shared-runtime report.
- [x] Add CI collection and artifact upload; use measured thresholds or baseline nonregression, never an invented percentage.

### 5. End-to-end acceptance and delivery

- [x] Build/typecheck/test every changed package; run architecture and documentation checks and the CLI plugin matrix.
- [x] Execute a suitable real wiki backlog item with local Claude through the supported CLI; inspect the selected item's acceptance criteria first and preserve the human merge gate.
- [x] Record a failed attempt, validate a correction with evidence, then prove a later related run receives the verified experience. Revoke it and prove it disappears from recall.
- [x] Update `docs/architecture/plugins.md` and its Chinese pair plus testing documentation with measured results, exact limits and any external prerequisites.
- [ ] Commit and push the task branch and publish a reviewable change request against the appropriate plugin baseline. Do not merge it.

## Acceptance boundaries

The local system is complete only when all local/mocked adapters run through the actual supported surfaces and the learning cycle is executable, not merely registered. External products requiring accounts or reachable infrastructure remain separately identified until exercised with those prerequisites. Repetition reduction is measured through duplicate fingerprints, occurrences and later use; no model can guarantee that it will never make another mistake.

## Measured evidence

- Shared packages / CLI / repository: 3,525 passed, four skipped; 47,922/55,041 reported source lines (87.06%), functions 82.92%, branches 84.27%. Desktop and subprocess internals are excluded from this coverage denominator.
- Plugin matrix: 97 local + 27 HTTP + 67 execution cases, plus one learning E2E including disable/re-enable and revocation.
- Desktop: typecheck, 921 unit tests and three Electron E2E passed. Real PTY: 16 passed. Real Claude Code: two local integration tests passed.
- Node 22.17.0 SQLite-warning regression passed. Workspace build/typecheck, architecture and documentation checks passed.
- CLI 0.2.42: 5.2 MiB macOS arm64 archive, offline installation and all 23 command entry points verified; installed locally using the standard installer.
- Real wiki work item `gitlab:w.src.corp.qihoo.net/fang/services/llm-wiki#21`: implementation retained on `afk/backlog-21`; targeted CSV tests (4), existing page tests (6) and typecheck passed in implementation and repaired QA worktrees. Independent managed QA remains separately tracked; no merge is performed.
