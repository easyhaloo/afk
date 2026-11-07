# Poll Until Complete

Poll an async job until completion or timeout.

## Concept

Submit an async task, then repeatedly query its status until it reaches a terminal state (COMPLETED, PAID, etc.) or timeout.

## Common Async Patterns

### 1. Trigger -> Poll Pattern (Most Common)

```
POST /async-endpoint     -> { run_id, status: "running" }
GET  /runs/:runId       -> { status: "running" | "completed" | "failed" }
```

```typescript
// Trigger async operation
const trigger = await apiContext.post('/async-action', { headers: authHeaders() });
const { run_id } = await trigger.json();

// Poll until completed
const result = await pollUntil(
  apiContext,
  `/runs/${run_id}`,
  (data) => data.status,
  ['completed', 'failed'],
  { intervalMs: 1000, timeoutMs: 30000 }
);
```

### 2. Issue with Cached Responses

**IMPORTANT**: Some GET endpoints return cached data that may be stale.

Example: A GET endpoint returns cached report with `issues: []`, but the actual
issue count is in the async run status endpoint under `summary`.

```typescript
// WRONG: Relying on cached issues array
const report = await apiContext.get('/some-report');
console.log(report.issues.length); // May be 0 even if there are issues

// CORRECT: Use the async run's summary for accurate counts
const run = await pollUntil(apiContext, `/runs/${runId}`, d => d.status, ['completed']);
console.log(run.summary.issue_count); // Accurate count
```

## Usage

```typescript
import { pollUntil } from '../utils/poll-until';

// Generic poll
const result = await pollUntil(apiContext, `/jobs/${jobId}`, data => data.status, ['COMPLETED']);

// Specialized polls
const order = await pollOrderPaid(apiContext, orderId);
const job = await pollJobComplete(apiContext, jobId);
```

## When to Use

- Payment processing (poll until PAID)
- Lint/scanning operations (poll until COMPLETED)
- File processing (poll until COMPLETED)
- Any async operation that changes status over time

## Anti-Patterns

### DON'T: Assume cached data is fresh

```typescript
// WRONG: Cache may be stale
const report = await apiContext.get('/some-report');
expect(report.issues.length).toBe(report.total_issues);

// CORRECT: Poll the async run for accurate status
const run = await pollUntil(apiContext, `/runs/${runId}`, d => d.status, ['completed']);
expect(run.summary.issue_count).toBe(report.total_issues);
```

### DON'T: Hardcode base URLs

```typescript
// WRONG
baseURL: 'https://api.example.com'

// CORRECT: Use env vars with sensible defaults
baseURL: process.env.BASE_URL || 'http://localhost:8080'
```

## Timeout Best Practices

| Operation Type | Suggested Timeout | Interval |
|----------------|------------------|----------|
| Fast sync ops | 5s | 500ms |
| Lint/scans | 30s | 1s |
| File processing | 60s | 2s |
| ML inference | 120s | 5s |
