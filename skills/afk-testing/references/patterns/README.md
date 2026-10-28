# Test Behavior Pattern Catalog

Load only references that match the implementation or risk. The structured index
is `catalog.yaml`. This is a catalog for choosing tests, not a checklist that
every project must implement.

## 1. Interaction and communication

| Pattern | Reference | Typical validation claims |
|---|---|---|
| Synchronous request/response | `synchronous.md` | Protocol status, business result, validation, side effects |
| Asynchronous request/reply and polling | `asynchronous.md` | Accepted vs completed, status transitions, bounded wait, cancellation |
| Event-driven / pub-sub | `event-driven.md` | Event schema, delivery, consumer effect, duplication |
| Callback / webhook | `callbacks.md` | Callback contract, auth/signature, retries, acknowledgement |
| Streaming / SSE / WebSocket / UI async | `streaming-ui-and-batch.md` | Framing, completion, reconnection, ordering, cleanup |
| Scheduled jobs and batch | `streaming-ui-and-batch.md` | Time boundaries, overlap, partial success, resume |
| Queue consumers / competing consumers | `concurrency-and-consistency.md` | Parallel processing, leases, duplicate claim, poison messages |

## 2. Business workflow and state

| Pattern | Reference | Typical validation claims |
|---|---|---|
| Business rules and status mapping | `business-rules-and-status.md` | Rule-to-case traceability, allowed/rejected status transitions |
| State machine and lifecycle | `workflows-and-state.md` | Guard conditions, legal transitions, terminal states |
| Long-running workflow / process manager | `workflows-and-state.md` | Checkpoint, timeout, resume, cancellation, recovery |
| Orchestration / choreography / fan-out-fan-in | `workflows-and-state.md` | Step coordination, partial results, deadline, correlation |
| Saga / compensation | `workflows-and-state.md` | Partial failure, compensation, eventual consistency |
| Event sourcing / CQRS / outbox | `workflows-and-state.md` | Replay, projections, commit/publish consistency, deduplication |

## 3. Reliability, delivery, concurrency

| Pattern | Reference | Typical validation claims |
|---|---|---|
| Timeout / deadline / cancellation | `reliability-and-delivery.md` | Bounded work, propagated cancellation, cleanup |
| Retry / backoff / fallback | `reliability-and-delivery.md` | Transient vs permanent failures, attempts, recovery |
| Idempotency / deduplication | `reliability-and-delivery.md` | Duplicate requests/messages don't duplicate protected effects |
| Circuit breaker / bulkhead / degradation | `reliability-and-delivery.md` | Failure isolation and recovery transitions |
| Rate limiting / throttling / quotas | `reliability-and-delivery.md`, `security-and-identity.md` | Per-principal boundaries and overload behavior |
| Dead-letter / replay | `reliability-and-delivery.md` | Poison messages, retry limit, replay safety |
| Race / ordering / optimistic concurrency | `concurrency-and-consistency.md` | Lost updates, sequence guarantees, conflicts |
| Eventual consistency / leases / competing workers | `concurrency-and-consistency.md` | Convergence, stale owners, duplicate concurrent work |

## 4. API, persistence, files, identity

| Pattern | Reference | Typical validation claims |
|---|---|---|
| API/schema/consumer-driven contracts | `api-contracts-and-data.md` | Producer/consumer compatibility |
| Serialization and schema evolution | `api-contracts-and-data.md` | Defaults, unknown fields, version compatibility |
| Database transactions and isolation | `api-contracts-and-data.md`, `concurrency-and-consistency.md` | Commit, rollback, constraints, isolation |
| Cache-aside / invalidation | `api-contracts-and-data.md` | Staleness, refresh, tenant separation |
| Pagination / filtering / sorting | `api-contracts-and-data.md` | Limits, cursor validity, stable result semantics |
| Accounts / roles / tenants / permissions | `identity-and-data.md`, `security-and-identity.md` | Lifecycle, RBAC/ABAC, tenant isolation |
| File upload and processing / claim check | `file-upload.md` | Content validation, storage, async processing, payload references, cleanup |
| External service adapters | `api-contracts-and-data.md` | Timeout, error mapping, sandbox contract |
| LLM and Agent behavior | `llm-calls.md` | Structured output, tool trace, task outcome, eval variance |

## 5. Messaging, pipeline, and gateway architecture

| Pattern | Reference | Typical validation claims |
|---|---|---|
| Queue-based load leveling / backpressure | `messaging-pipeline-and-gateway.md` | Buffer limits, overload policy, backlog drain, bounded resources |
| Priority queues / fair scheduling | `messaging-pipeline-and-gateway.md` | Priority contract, starvation and fairness |
| Pipes and filters / processing pipeline | `messaging-pipeline-and-gateway.md` | Stage contracts, order, failure routing, partial results |
| API gateway / aggregation / BFF | `messaging-pipeline-and-gateway.md` | Auth propagation, timeout, aggregation, partial downstream failure |
| Messaging bridge / protocol adapter | `messaging-pipeline-and-gateway.md` | Schema mapping, acknowledgements, correlation and duplicate transfer |

## 6. Deployment and cross-cutting quality attributes

| Pattern / quality dimension | Reference | Typical validation claims |
|---|---|---|
| Feature flags / gradual rollout / canary | `deployment-and-migration.md` | Enabled and disabled paths, targeting, safe rollout/rollback |
| Schema/data migrations / rolling upgrades | `deployment-and-migration.md` | Old/new compatibility, interruption, backfill, recovery |
| Performance / load / stress / soak | `quality-attributes.md` | Latency/throughput/resource thresholds under a declared workload |
| Fault injection / recovery | `quality-attributes.md`, `reliability-and-delivery.md` | Partial outage behavior, recovery, bounded resource use |
| Accessibility / visual behavior | `quality-attributes.md`, `streaming-ui-and-batch.md` | Keyboard, focus, visible errors, stable UI contracts |
| Observability / operability | `quality-attributes.md` | Correlation, meaningful logs/metrics/traces, secret redaction |
| Compatibility / privacy / security | `quality-attributes.md`, `security-and-identity.md` | Supported versions, data protection, explicit policy constraints |

## 7. Testing techniques (not runtime patterns)

| Technique | Reference | Use |
|---|---|---|
| BDD / acceptance examples | `testing-techniques.md` | Traceable business scenarios with observable outcomes |
| Equivalence partitions / boundary values / decision tables | `testing-techniques.md` | Systematic input and business-rule coverage |
| Property-based / metamorphic | `testing-techniques.md` | Invariants or relations across generated inputs |
| Fuzzing | `testing-techniques.md` | Parsers, decoders, untrusted input |
| Model-based / stateful sequence testing | `testing-techniques.md` | State machines and multi-step workflows |
| Differential / golden / snapshot | `testing-techniques.md` | Compare implementations or stable artifacts |
| Mutation / negative controls | `testing-techniques.md` | Validate whether assertions detect plausible bugs |
| Exploratory / risk-based | `testing-techniques.md` | Discover hidden failures and prioritize risk |
| Isolation / flakiness analysis | `testing-techniques.md` | Reproducible, independent test execution |

## 8. Code-level behavioral design patterns

See `behavioral-design-patterns.md` for Strategy, Observer, Command, State,
Chain of Responsibility, Mediator, Template Method, Iterator, Memento,
Visitor, and Interpreter. These are not the same classification as runtime
interaction patterns; test the behavior contract, not the pattern label.

## Composition rule

Patterns are independent dimensions and may be combined. For example, a file
upload can be an API contract test using a synthetic account, followed by an
asynchronous worker, an event, and a callback. Choose the lowest test layer
that proves each claim; avoid duplicating all assertions in E2E tests.
