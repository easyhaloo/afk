# Deployment, Feature Flag, and Migration Patterns

Load when a change affects mixed application versions, rollout controls, configuration, or persisted data migrations.

## Feature flags and gradual rollout

Test enabled/disabled paths, defaults, targeting rules, tenant/user scope, flag changes during active sessions, cleanup of retired flags, and safe behavior if the flag service is unavailable. Ensure both code paths remain tested while the flag is active.

## Rolling and canary deployments

Validate compatibility between old and new producers/consumers, APIs/events/schema versions, and shared data during overlap. Verify health checks and rollout metrics correspond to meaningful behavior. If canary promotion has explicit thresholds, test the decision signal and rollback behavior.

## Database and data migrations

Test migration from representative old schemas/data, preservation of invariants, defaults/backfills, idempotent reruns if promised, large/batched migration progress, interruption and resume, and rollback or forward-fix constraints. Use sanitized representative fixtures; never run destructive migration tests against production data.

## Configuration and secrets rotation

Test missing/invalid configuration, safe defaults, dynamic reload if supported, secret expiry/rotation, and failure during dependency reconnection. Assert secrets do not appear in logs, generated reports or snapshots.

## Sources

- Azure Cloud Design Patterns: https://learn.microsoft.com/en-us/azure/architecture/patterns
- Martin Fowler, Practical Test Pyramid: https://www.martinfowler.com/articles/practical-test-pyramid.html
