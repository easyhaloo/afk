# Cross-Cutting Quality Attribute Tests

These are quality dimensions, not mutually exclusive runtime behaviors. Select tests based on the project's acceptance criteria, architecture, risk and available environment.

## Performance, load, stress and soak

Distinguish:
- **Performance / latency:** response-time distribution, throughput and resource usage under a stated workload.
- **Load:** behavior at expected and peak traffic.
- **Stress:** behavior beyond expected capacity and the point of failure.
- **Soak / endurance:** memory, handles, queues and latency drift over prolonged operation.
- **Capacity / scalability:** how throughput and latency change as workers or resources scale.

Specify workload, concurrency, data volume, duration, warm-up, environment and pass thresholds. Assert percentiles and resource bounds where the contract specifies them; do not infer a threshold from a single noisy run.

## Fault injection and resilience exercise

Inject controlled dependency delay, disconnect, error, process restart, message duplication, or partial availability in an isolated environment. Verify recovery, data integrity, bounded resource consumption and observability. Avoid unbounded or destructive chaos against shared environments.

## Security validation

Threat-model the actual attack surface and select checks for authentication, authorization, tenant isolation, input parsing, secret exposure, dependency and data boundaries. Use the dedicated `security-and-identity.md` and project security standards to derive concrete cases. Do not treat a generic scanner result as proof of security.

## Accessibility, visual behavior and usability

Verify keyboard navigation, semantic roles/names, focus behavior, error announcements, contrast or project-required accessibility criteria. Use visual snapshots only for stable UI contracts; combine automated checks with human review for subjective usability and visual correctness.

## Observability and operability

For critical flows, verify correlation IDs propagate across requests, jobs, events and callbacks; failures produce actionable structured logs/metrics/traces; sensitive values are redacted; health/readiness signals match actual availability. Assert meaningful telemetry rather than exact timestamps or incidental log wording.

## Compatibility and migration

Test supported runtime/browser/client versions, old/new schema interactions, rolling upgrades, feature-flag paths, configuration changes and data migrations. Verify deploy order and rollback constraints when producer and consumer versions can coexist.

## Sources

- Azure Well-Architected design patterns: https://learn.microsoft.com/en-us/azure/architecture/patterns
- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
- Martin Fowler, Practical Test Pyramid: https://www.martinfowler.com/articles/practical-test-pyramid.html
