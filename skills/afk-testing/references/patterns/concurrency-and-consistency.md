# Concurrency, Ordering, and Consistency Patterns

Load when multiple workers, requests, transactions, or replicas can act on overlapping state.

## Concurrent updates and race conditions

Identify the shared resource and intended conflict policy. Start competing operations with controlled barriers rather than arbitrary sleeps. Verify invariants under concurrent writes, lost-update prevention, locking/compare-and-swap behavior, and response semantics for conflicts.

## Ordering and reordering

Test only the ordering guarantees that the contract promises: per key, per partition, per workflow, or global. Where order is not guaranteed, verify the consumer tolerates reordering or uses sequence/version checks. Include delayed, duplicate, and stale events when plausible.

## Eventual consistency and read models

Identify the source of truth, propagated view, completion signal, and permitted convergence window. Assert eventual convergence using bounded condition-based waiting. Verify stale reads do not cause forbidden actions, and distinguish delayed propagation from data loss.

## Leases, locks, and leader election

Test lease expiry, renewal failure, stale owners, fencing tokens, split-brain prevention, and recovery after owner termination if these are part of the system. Avoid timing-sensitive tests with overly narrow assumptions about scheduling.

## Parallel workers and competing consumers

Test multiple consumers processing different messages concurrently, duplicate claim attempts, visibility/lease expiry, worker crash, and fairness/throughput guarantees when specified. Verify the same logical item is not processed concurrently in ways that violate business invariants.

## Database isolation and optimistic concurrency

Use concurrent transactions to verify unique constraints, isolation levels, optimistic version checks, deadlock handling, and retry boundaries. Prefer the actual supported database for integration tests where transaction semantics are the subject of the test.

## Sources

- Azure Competing Consumers: https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers
- Azure asynchronous messaging: https://learn.microsoft.com/en-us/azure/architecture/guide/technology-choices/messaging
- Azure Cloud Design Patterns: https://learn.microsoft.com/en-us/azure/architecture/patterns
